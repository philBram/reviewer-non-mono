import { DirectoryLoader } from 'langchain/document_loaders/fs/directory';
import { TextLoader } from 'langchain/document_loaders/fs/text';
import { GraphDocument, Relationship, Node } from '@langchain/community/graphs/document';
import { Document } from '@langchain/core/documents';
import { Project, SyntaxKind, ClassDeclaration, InterfaceDeclaration, FunctionDeclaration, MethodDeclaration, Statement, Node as TsMorphNode } from 'ts-morph';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createEmbeddingModel, CreateEmbeddingModelOptions } from '../../lib/ai-core';
import { Embeddings } from '@langchain/core/embeddings';
import { DiffDetails } from '../git-setup/git-setup';
import { Neo4jClient, logger } from '../../lib/ai-utils';

export class AstGraphDbSetup {
  private readonly ignoreRegex = /node_modules|\/dist\/|\/build\/|\.spec\.ts$|\.d\.ts$|jest.*\.ts$|\.ya?ml$|\.json$/;
  private readonly embeddingModel: Embeddings;
  private readonly project: Project;
  private readonly entityUuidMap = new Map<string, string>();

  constructor(createEmbeddingOpts: CreateEmbeddingModelOptions) {
    this.embeddingModel = createEmbeddingModel(createEmbeddingOpts);
    this.project = new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
      },
    });
  }

  private async getGraph() {
    return await Neo4jClient.getClient();
  }

  private getOrCreateUuid(name: string, filePath: string) {
    const key = `${name}:${filePath}`;

    if (!this.entityUuidMap.has(key)) {
      this.entityUuidMap.set(key, uuidv4());
    }

    return this.entityUuidMap.get(key)!;
  }

  private async getDeclarationName(decl: Statement | MethodDeclaration) {
    const declInfo = {
      name: '',
      type: '',
    };

    if (TsMorphNode.isClassDeclaration(decl)) {
      declInfo.name = decl.getName() || '';
      declInfo.type = 'CLASS';
    } else if (TsMorphNode.isInterfaceDeclaration(decl)) {
      declInfo.name = decl.getName() || '';
      declInfo.type = 'INTERFACE';
    } else if (TsMorphNode.isFunctionDeclaration(decl)) {
      declInfo.name = decl.getName() || '';
      declInfo.type = 'FUNCTION';
    } else if (TsMorphNode.isMethodDeclaration(decl)) {
      declInfo.name = decl.getName();
      declInfo.type = 'METHOD';
    } else {
      declInfo.name = decl.getKindName();
      declInfo.type = decl.getKindName();
    }

    return declInfo;
  }

  private async loadDocuments() {
    const loader = new DirectoryLoader(
      process.env.REPO_PATH || '',
      { '.ts': (path) => new TextLoader(path) },
      true,
      'ignore'
    );

    const documents = await loader.load();
    const filteredDocuments = documents.filter(doc => {
      const path = doc.metadata.source.toString();
      return path ? !this.ignoreRegex.test(path) : true;
    });

    return filteredDocuments;
  }

  private async addDiffHunkNode(diffDetails: DiffDetails[], decl: Statement | MethodDeclaration, declUuid: string, relativeRepoPath: string, nodes: Node[], relationships: Relationship[]) {
    const diffHunksForFile = diffDetails.filter(diff => diff.file_path === relativeRepoPath);
    
    if (diffHunksForFile.length === 0) {
      return;
    }

    const diffHunks = diffHunksForFile[0].hunks;
    const declStartLine = decl.getStartLineNumber();
    const declEndLine = decl.getEndLineNumber();

    for (const hunk of diffHunks) {
      const hunkOverlapsDecl = 
        hunk.start_line <= declEndLine && hunk.end_line >= declStartLine ||
        hunk.start_line >= declStartLine && hunk.end_line <= declEndLine;
      
      if (hunkOverlapsDecl) {
        const addedLines = hunk.content
          .filter(line => line.startsWith('+'))
          .map(line => line.slice(1));

        const removedLines = hunk.content
          .filter(line => line.startsWith('-'))
          .map(line => line.slice(1));

        const diffContent = hunk.content.join('\n');
        const contentEmbeddings = await this.embeddingModel.embedDocuments([diffContent]);
        const embeddingVector = contentEmbeddings[0];
        const diffUuid = this.getOrCreateUuid('' + hunk.start_line + hunk.end_line, relativeRepoPath);
        const declInfo = await this.getDeclarationName(decl);

        nodes.push(
          new Node({
            id: diffUuid,
            type: 'DIFF_HUNK',
            properties: {
              embedding: embeddingVector,
              content: diffContent,
              added_lines: addedLines,
              removed_lines: removedLines,
              commit_id: hunk.commit_id,
              start_line: hunk.start_line,
              end_line: hunk.end_line,
              source: relativeRepoPath,
            }
          })
        );

        relationships.push(
          new Relationship({
            source: new Node({
              id: declUuid,
              type: declInfo.type,
            }),
            target: new Node({
              id: diffUuid,
              type: 'DIFF_HUNK',
            }),
            type: 'HAS_DIFF',
          })
        );
      }
    }
  }

  private async parseTypeScriptFile(filePath: string, diffDetails: DiffDetails[], content: string) {
    const sourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });
    const relativeRepoPath = path.relative(process.env.REPO_PATH || '', filePath);

    const nodes: Node[] = [];
    const relationships: Relationship[] = [];

    for (const cls of sourceFile.getClasses()) {
      const className = cls.getName();

      if (!className) {
        continue;
      }

      const classUuid = this.getOrCreateUuid(className, relativeRepoPath);

      nodes.push(
        new Node({
          id: classUuid,
          type: 'CLASS',
          properties: {
            name: className,
            source: relativeRepoPath,
          }
        })
      );

      await this.addDiffHunkNode(diffDetails, cls, classUuid, relativeRepoPath, nodes, relationships);

      const baseClass = cls.getBaseClass();

      if (baseClass) {
        const baseClassName = baseClass.getName();

        if (baseClassName) {
          const relativeSourcePath = path.relative(process.env.REPO_PATH || '', baseClass.getSourceFile().getFilePath());
          const baseClassUuid = this.getOrCreateUuid(baseClassName, relativeSourcePath) || '';

          relationships.push(
            new Relationship({
              source: new Node({
                id: classUuid,
                type: 'CLASS',
              }),
              target: new Node({ 
                id: baseClassUuid,
                type: 'CLASS',
              }),
              type: 'EXTENDS',
            })
          );
        }
      }

      for (const impl of cls.getImplements()) {
        const interfaceName = impl.getText();
        const relativeSourcePath = path.relative(process.env.REPO_PATH || '', impl.getSourceFile().getFilePath());
        const interfaceUuid = this.getOrCreateUuid(interfaceName, relativeSourcePath);

        relationships.push(
          new Relationship({
            source: new Node({ 
              id: classUuid,
              type: 'CLASS',
             }),
            target: new Node({ 
              id: interfaceUuid,
              type: 'INTERFACE',
             }),
            type: 'IMPLEMENTS',
          })
        );
      }

      await this.extractMethods(diffDetails, cls, classUuid, nodes, relationships);
    }

    for (const iface of sourceFile.getInterfaces()) {
      const interfaceName = iface.getName();

      if (!interfaceName) {
        continue;
      }

      const interfaceUuid = this.getOrCreateUuid(interfaceName, relativeRepoPath);

      nodes.push(
        new Node({
          id: interfaceUuid,
          type: 'INTERFACE',
          properties: {
            name: interfaceName,
            source: relativeRepoPath,
          }
        })
      );

      await this.addDiffHunkNode(diffDetails, iface, interfaceUuid, relativeRepoPath, nodes, relationships);

      for (const baseDecl of iface.getBaseDeclarations()) {
        if (baseDecl.getKind() === SyntaxKind.InterfaceDeclaration) {
          const baseInterfaceName = (baseDecl as InterfaceDeclaration).getName();

          if (baseInterfaceName) {
            const relativeSourcePath = path.relative(process.env.REPO_PATH || '', baseDecl.getSourceFile().getFilePath());
            const baseInterfaceUuid = this.getOrCreateUuid(baseInterfaceName, relativeSourcePath);

            relationships.push(
              new Relationship({
                source: new Node({ 
                  id: interfaceUuid,
                  type: 'INTERFACE',
                }),
                target: new Node({ 
                  id: baseInterfaceUuid,
                  type: 'INTERFACE',
                }),
                type: 'EXTENDS',
              })
            );
          }
        }
      }
    }

    for (const func of sourceFile.getFunctions()) {
      const functionName = func.getName();

      if (!functionName) {
        continue;
      }

      const paramTypes = func.getParameters()
        .map(param => param.getType().getText());
      const functionUuid = this.getOrCreateUuid(functionName + paramTypes, relativeRepoPath);

      nodes.push(
        new Node({ 
          id: functionUuid, 
          type: 'FUNCTION', 
          properties: 
          {
            name: functionName,
            source: relativeRepoPath,
          }
        })
      );

      await this.addDiffHunkNode(diffDetails, func, functionUuid, relativeRepoPath, nodes, relationships);
      await this.extractCallsFromFunction(func, functionUuid, nodes, relationships);
    }

    this.project.removeSourceFile(sourceFile);

    return new GraphDocument({
      nodes,
      relationships,
      source: new Document({ pageContent: content, metadata: { source: filePath } }),
    });
  }

  private async extractMethods(
    diffDetails: DiffDetails[],
    cls: ClassDeclaration,
    classUuid: string,
    nodes: Node[],
    relationships: Relationship[],
  ) {
    for (const method of cls.getMethods()) {
      const methodName = method.getName();

      if (!methodName) {
        continue;
      }

      const relativeSourcePath = path.relative(process.env.REPO_PATH || '', method.getSourceFile().getFilePath());
      const paramTypes = method.getParameters()
        .map(param => param.getType().getText());
      const methodUuid = this.getOrCreateUuid(methodName + paramTypes, relativeSourcePath);

      nodes.push(
        new Node({
          id: methodUuid, 
          type: 'METHOD',
          properties: {
            name: methodName,
            source: relativeSourcePath,
          }
        })
      );

      await this.addDiffHunkNode(diffDetails, method, methodUuid, relativeSourcePath, nodes, relationships);

      relationships.push(
        new Relationship({
          source: new Node({ 
            id: classUuid, 
            type: 'CLASS', 
          }),
          target: new Node({ 
            id: methodUuid, 
            type: 'METHOD', 
          }),
          type: 'CONTAINS',
        })
      );

      if (method.getBody()) {
        await this.extractCallsFromFunction(method, methodUuid, nodes, relationships);
      }
    }
  }

  private async extractCallsFromFunction(
    decl: FunctionDeclaration | MethodDeclaration,
    callerUuid: string,
    nodes: Node[],
    relationships: Relationship[],
  ) {
    const callExpressions = decl.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const callExpr of callExpressions) {
      const expression = callExpr.getExpression();
      const callText = expression.getText();
      const relativeSourcePath = path.relative(process.env.REPO_PATH || '', callExpr.getSourceFile().getFilePath());
      const targetUuid = this.getOrCreateUuid(callText, relativeSourcePath);
      const declInfo = await this.getDeclarationName(decl);

      nodes.push(
        new Node({
          id: targetUuid,
          type: 'FUNCTION',
          properties: {
            name: callText,
            source: relativeSourcePath,
          }
        })
      );

      relationships.push(
        new Relationship({
          source: new Node({ 
            id: callerUuid, 
            type: declInfo.type,
          }),
          target: new Node({ 
            id: targetUuid, 
            type: 'FUNCTION', 
          }),
          type: 'CALLS',
        })
      );
    }
  }

  private async createVectorIndex() {
    const graph = await this.getGraph();
    const vectorIndex = 
      { name: 'diff_vector_index', label: 'DIFF_HUNK', property: 'embedding' };

    const result = await graph.query(`
      MATCH (h:${vectorIndex.label})
      WHERE h.${vectorIndex.property} IS NOT NULL
      RETURN h.${vectorIndex.property} AS embedding
      LIMIT 1
    `);
    
    const dimensions = result?.[0]?.embedding?.length;
    
    if (!dimensions) {
      logger.debug('No embeddings found, skipping vector index creation');
      return;
    }

    try {
      try {
        await graph.query(`DROP INDEX ${vectorIndex.name}`);
        logger.debug({ indexName: vectorIndex.name }, 'Dropped existing vector index');
      } catch (_error) {
        logger.debug('Vector index did not exist, proceeding to create new one');
      }

      await graph.query(`
        CREATE VECTOR INDEX ${vectorIndex.name}
        FOR (h:${vectorIndex.label})
        ON h.${vectorIndex.property}
        OPTIONS {indexConfig: {
          \`vector.dimensions\`: ${dimensions},
          \`vector.similarity_function\`: 'cosine'
        }}
      `);
      logger.info({ indexName: vectorIndex, dimensions }, 'Vector index created successfully');
    } catch (error) {
      logger.error({ err: error, indexName: vectorIndex }, 'Error creating vector index');
    }
  }

  private async createKeywordIndex() {
    const graph = await this.getGraph();

    const indexName = 'diff_keyword_index';

    try {
      try {
        await graph.query(`DROP INDEX ${indexName}`);
        logger.debug({ indexName }, 'Dropped existing index');
      } catch (_error) {
        logger.debug('Keyword index did not exist, proceeding to create new one');
      }

      await graph.query(`
        CREATE FULLTEXT INDEX ${indexName}
        FOR (n:DIFF_HUNK)
        ON EACH [n.content, n.source]
      `);
      logger.info({ indexName }, 'Created fulltext index');
    } catch (error) {
      logger.error({ err: error, indexName }, 'Error creating keyword index');
    }
  }

  async clearGraph() {
    const graph = await this.getGraph();
    await graph.query('MATCH (n) DETACH DELETE n');

    logger.info('Graph cleared successfully');
  }

  async buildGraph(diffDetails: DiffDetails[]) {
    logger.info('Starting Neo4j graph database setup');
    await this.clearGraph();
    
    const documents = await this.loadDocuments();
    logger.info({ documentCount: documents.length }, 'TypeScript files found');

    logger.debug('Parsing TypeScript files using ts-morph AST');
    const graphDocuments: GraphDocument[] = [];
    
    for (const doc of documents) {
      const filePath = doc.metadata.source;
      const content = doc.pageContent;
      
      try {
        const graphDoc = await this.parseTypeScriptFile(filePath, diffDetails, content);
        if (graphDoc.nodes.length > 0) {
          graphDocuments.push(graphDoc);
        }
      } catch (error) {
        logger.error({ err: error, filePath }, 'Error parsing TypeScript file');
      }
    }

    const totalNodes = graphDocuments.reduce((sum, doc) => sum + doc.nodes.length, 0);
    const totalRelationships = graphDocuments.reduce((sum, doc) => sum + doc.relationships.length, 0);

    logger.info({ documentCount: graphDocuments.length }, 'Storing graph in Neo4j');
    try {
      const graph = await this.getGraph();
      await graph.addGraphDocuments(graphDocuments);
      logger.info({ nodes: totalNodes, relationships: totalRelationships }, 'Graph stored successfully');
    } catch (error) {
      logger.error({ err: error, nodeCount: totalNodes }, 'Error storing graph documents in Neo4j');
    }

    await this.createVectorIndex();
    await this.createKeywordIndex();

    logger.info({ nodes: totalNodes, relationships: totalRelationships }, 'Graph build complete');
  }
}
