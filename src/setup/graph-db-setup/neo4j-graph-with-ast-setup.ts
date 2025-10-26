import { DirectoryLoader } from 'langchain/document_loaders/fs/directory';
import { TextLoader } from 'langchain/document_loaders/fs/text';
import { GraphDocument, Relationship, Node } from '@langchain/community/graphs/document';
import { Document } from '@langchain/core/documents';
import { Project, SyntaxKind, ClassDeclaration, InterfaceDeclaration, FunctionDeclaration, MethodDeclaration, Statement, Node as TsMorphNode } from 'ts-morph';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DiffDetails } from '../git-setup/git-setup';
import { Neo4jClient, getIgnoreRegex, logger } from '../../lib/ai-utils';

export class Neo4jGraphWithAst {
  private readonly ignoreRegex = getIgnoreRegex();
  private readonly project: Project;
  private readonly declUuids = new Map<string, string>();
  private readonly addedNodes = new Set<string>();
  private readonly addedRelationships = new Set<string>();
  private readonly nodes: Node[] = [];
  private readonly relationships: Relationship[] = [];

  constructor() {
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

    if (!this.declUuids.has(key)) {
      this.declUuids.set(key, uuidv4());
    }

    return this.declUuids.get(key)!;
  }

  private addNodeIfNew(node: Node) {
    const nodeId = String(node.id);

    if (this.addedNodes.has(nodeId)) {
      return;
    }

    this.addedNodes.add(nodeId);
    this.nodes.push(node);
  }

  private addRelationshipIfNew(relationship: Relationship) {
    const relationshipSourceId = String(relationship.source.id);
    const relationshipTargetId = String(relationship.target.id);
    const key = `${relationshipSourceId}:${relationshipTargetId}:${relationship.type}`;

    if (this.addedRelationships.has(key)) {
      return;
    }

    this.addedRelationships.add(key);
    this.relationships.push(relationship);
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

  private async addDiffHunkNode(diffDetails: DiffDetails[], decl: Statement | MethodDeclaration, declUuid: string, relativeRepoPath: string) {
    const diffHunksForFile = diffDetails.find(diff => diff.filePath === relativeRepoPath);

    if (!diffHunksForFile) {
      return;
    }

    const diffHunks = diffHunksForFile.hunks;
    const declStartLine = decl.getStartLineNumber();
    const declEndLine = decl.getEndLineNumber();

    for (const hunk of diffHunks) {
      const hunkOverlapsDecl = 
        hunk.startLine <= declEndLine && hunk.endLine >= declStartLine ||
        hunk.startLine >= declStartLine && hunk.endLine <= declEndLine;

      if (hunkOverlapsDecl) {
        const addedLines = hunk.content
          .filter(line => line.startsWith('+'))
          .map(line => line.slice(1));

        const removedLines = hunk.content
          .filter(line => line.startsWith('_'))
          .map(line => line.slice(1));

        const diffUuid = this.getOrCreateUuid('' + hunk.startLine + hunk.endLine, relativeRepoPath);
        const declInfo = await this.getDeclarationName(decl);

        this.addNodeIfNew(
          new Node({
            id: diffUuid,
            type: 'DIFF_HUNK',
            properties: {
              diffType: hunk.diffType,
              addedLines: addedLines,
              removedLines: removedLines,
              startLine: hunk.startLine,
              endLine: hunk.endLine,
              source: relativeRepoPath,
            }
          })
        );

        this.addRelationshipIfNew(
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

    for (const cls of sourceFile.getClasses()) {
      const className = cls.getName();

      if (!className) {
        continue;
      }

      const classUuid = this.getOrCreateUuid(className, relativeRepoPath);

      this.addNodeIfNew(
        new Node({
          id: classUuid,
          type: 'CLASS',
          properties: {
            name: className,
            source: relativeRepoPath,
          }
        })
      );

      await this.addDiffHunkNode(diffDetails, cls, classUuid, relativeRepoPath);

      const baseClass = cls.getBaseClass();

      if (baseClass) {
        const baseClassName = baseClass.getName();

        if (!baseClassName) {
          continue;
        }

        const relativeSourcePath = path.relative(process.env.REPO_PATH || '', baseClass.getSourceFile().getFilePath());
        const baseClassUuid = this.getOrCreateUuid(baseClassName, relativeSourcePath) || '';

        this.addNodeIfNew(
          new Node({
            id: baseClassUuid,
            type: 'CLASS',
            properties: {
              name: baseClassName,
              source: relativeSourcePath,
            }
          })
        );

        this.addRelationshipIfNew(
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

      for (const impl of cls.getImplements()) {
        const interfaceName = impl.getText();
        const relativeSourcePath = path.relative(process.env.REPO_PATH || '', impl.getSourceFile().getFilePath());
        const interfaceUuid = this.getOrCreateUuid(interfaceName, relativeSourcePath);

        this.addNodeIfNew(
          new Node({
            id: interfaceUuid,
            type: 'INTERFACE',
            properties: {
              name: interfaceName,
              source: relativeSourcePath,
            }
          })
        );

        this.addRelationshipIfNew(
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

      await this.extractMethods(diffDetails, cls, classUuid);
    }

    for (const iface of sourceFile.getInterfaces()) {
      const interfaceName = iface.getName();

      if (!interfaceName) {
        continue;
      }

      const interfaceUuid = this.getOrCreateUuid(interfaceName, relativeRepoPath);

      this.addNodeIfNew(
        new Node({
          id: interfaceUuid,
          type: 'INTERFACE',
          properties: {
            name: interfaceName,
            source: relativeRepoPath,
          }
        })
      );

      await this.addDiffHunkNode(diffDetails, iface, interfaceUuid, relativeRepoPath);

      for (const baseDecl of iface.getBaseDeclarations()) {
        if (baseDecl.getKind() === SyntaxKind.InterfaceDeclaration) {
          const baseInterfaceName = (baseDecl as InterfaceDeclaration).getName();

          if (baseInterfaceName) {
            const relativeSourcePath = path.relative(process.env.REPO_PATH || '', baseDecl.getSourceFile().getFilePath());
            const baseInterfaceUuid = this.getOrCreateUuid(baseInterfaceName, relativeSourcePath);

            this.addNodeIfNew(
              new Node({
                id: baseInterfaceUuid,
                type: 'INTERFACE',
                properties: {
                  name: baseInterfaceName,
                  source: relativeSourcePath,
                }
              })
            );

            this.addRelationshipIfNew(
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

      this.addNodeIfNew(
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

      await this.addDiffHunkNode(diffDetails, func, functionUuid, relativeRepoPath);
      await this.extractMethodCalls(func, functionUuid);
      await this.extractFunctionCalls(func, functionUuid);
    }

    return new GraphDocument({
      nodes: this.nodes,
      relationships: this.relationships,
      source: new Document({ pageContent: content, metadata: { source: filePath } }),
    });
  }

  private async extractMethods(
    diffDetails: DiffDetails[],
    cls: ClassDeclaration,
    classUuid: string,
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

      this.addNodeIfNew(
        new Node({
          id: methodUuid, 
          type: 'METHOD',
          properties: {
            name: methodName,
            source: relativeSourcePath,
          }
        })
      );

      this.addRelationshipIfNew(
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

      await this.addDiffHunkNode(diffDetails, method, methodUuid, relativeSourcePath);
      await this.extractMethodCalls(method, methodUuid);
      await this.extractFunctionCalls(method, methodUuid);
    }
  }

  private async extractMethodCalls(decl: MethodDeclaration | FunctionDeclaration, declUuid: string) {
    const references = decl.findReferencesAsNodes();
    const declInfo = await this.getDeclarationName(decl);

    for (const reference of references) {
      const callingMethods = reference.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);

      if (callingMethods) {
        const methodName = callingMethods.getName();
        const callingDeclInfo = await this.getDeclarationName(callingMethods);

        if (!methodName) {
          continue;
        }

        const paramTypes = callingMethods.getParameters()
          .map(param => param.getType().getText());
        const relativeSourcePath = path.relative(process.env.REPO_PATH || '', callingMethods.getSourceFile().getFilePath());
        const callerUuid = this.getOrCreateUuid(methodName + paramTypes, relativeSourcePath);

        this.addNodeIfNew(
          new Node({
            id: callerUuid,
            type: callingDeclInfo.type,
            properties: {
              name: methodName,
              source: relativeSourcePath,
            }
          })
        );

        if (callerUuid === declUuid) {
          continue;
        }

        this.addRelationshipIfNew(
          new Relationship({
            source: new Node({ 
              id: callerUuid, 
              type: callingDeclInfo.type, 
            }),
            target: new Node({ 
              id: declUuid, 
              type: declInfo.type, 
            }),
            type: 'CALLS',
          })
        );
      }
    }
  }

  private async extractFunctionCalls(decl: MethodDeclaration | FunctionDeclaration, declUuid: string) {
    const references = decl.findReferencesAsNodes();
    const declInfo = await this.getDeclarationName(decl);

    for (const reference of references) {
      const callingFunction = reference.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration);

      if (callingFunction) {
        const methodName = callingFunction.getName();
        const callingDeclInfo = await this.getDeclarationName(callingFunction);

        if (!methodName) {
          continue;
        }

        const paramTypes = callingFunction.getParameters()
          .map(param => param.getType().getText());
        const relativeSourcePath = path.relative(process.env.REPO_PATH || '', callingFunction.getSourceFile().getFilePath());
        const callerUuid = this.getOrCreateUuid(methodName + paramTypes, relativeSourcePath);

        this.addNodeIfNew(
          new Node({
            id: callerUuid,
            type: callingDeclInfo.type,
            properties: {
              name: methodName,
              source: relativeSourcePath,
            }
          })
        );

        if (callerUuid === declUuid) {
          continue;
        }

        this.addRelationshipIfNew(
          new Relationship({
            source: new Node({ 
              id: callerUuid, 
              type: callingDeclInfo.type, 
            }),
            target: new Node({ 
              id: declUuid, 
              type: declInfo.type, 
            }),
            type: 'CALLS',
          })
        );
      }
    }
  }

  filterGraph(hops: number) {
    const affectedNodeIds = new Set<string>();

    for (const relationship of this.relationships) {
      const sourceId = String(relationship.source.id);

      if (relationship.type === 'HAS_DIFF') {
        affectedNodeIds.add(sourceId);
      }
    }

    let currentLevel = Array.from(affectedNodeIds);
    
    for (let i = 0; i < hops; i++) {
      const nextLevel: string[] = [];

      for (const current of currentLevel) {
        const neighbors = this.relationships
          .filter(relationship => 
            String(relationship.source.id) === current || 
            String(relationship.target.id) === current);

        for (const neighbor of neighbors) {
          const neighborId = String(
            String(neighbor.source.id) === current ? 
            neighbor.target.id : 
            neighbor.source.id
          );

          if (!affectedNodeIds.has(neighborId)) {
            affectedNodeIds.add(neighborId);
            nextLevel.push(neighborId);
          }
        }
      }

      if (nextLevel.length === 0) {
        break;
      }
      
      currentLevel = nextLevel;
    }

    const filteredNodes = this.nodes.filter(node => affectedNodeIds.has(String(node.id)));
    const filteredRelationships = this.relationships.filter(relationship => 
      (affectedNodeIds.has(String(relationship.source.id)) &&
      affectedNodeIds.has(String(relationship.target.id))) ||
      relationship.type === 'HAS_DIFF'
    );

    return new GraphDocument({
      nodes: filteredNodes,
      relationships: filteredRelationships,
      source: new Document({ pageContent: `Filtered Graph with ${hops} hops`, metadata: {} }),
    });
  }

  async clearGraph() {
    const graph = await this.getGraph();
    await graph.query('MATCH (n) DETACH DELETE n');

    logger.info('Graph cleared successfully');
  }

  async buildGraph(diffDetails: DiffDetails[], hops: number = 3) {
    logger.info('Starting Neo4j graph database setup');
    await this.clearGraph();
    
    const documents = await this.loadDocuments();
    logger.info({ documentCount: documents.length }, 'TypeScript files found');

    for (const doc of documents) {
      const filePath = doc.metadata.source;
      const content = doc.pageContent;
      
      try {
        this.project.createSourceFile(filePath, content, { overwrite: true });
      } catch (error) {
        logger.error({ err: error, filePath }, 'Error loading source file into project');
      }
    }

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

    const graphDocumentsFiltered = this.filterGraph(hops);

    logger.info('Storing graph in Neo4j');
    try {
      const graph = await this.getGraph();

      await graph.addGraphDocuments([graphDocumentsFiltered]);
    } catch (error) {
      logger.error({ err: error }, 'Error storing graph documents in Neo4j');
    }

    logger.debug('Cleaning up ts-morph project');
    for (const sourceFile of this.project.getSourceFiles()) {
      this.project.removeSourceFile(sourceFile);
    }

    logger.info('Graph build complete');
  }
}
