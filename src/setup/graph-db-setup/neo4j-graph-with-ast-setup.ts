import { DirectoryLoader } from 'langchain/document_loaders/fs/directory';
import { TextLoader } from 'langchain/document_loaders/fs/text';
import { GraphDocument, Relationship, Node } from '@langchain/community/graphs/document';
import { Document } from '@langchain/core/documents';
import { Project, SyntaxKind, ClassDeclaration, InterfaceDeclaration, FunctionDeclaration, MethodDeclaration, Statement, Node as TsMorphNode, CallExpression, SourceFile } from 'ts-morph';
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

  private async getGraphClient() {
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

  private async getDeclarationName(decl: Statement | MethodDeclaration | CallExpression) {
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
    } else if (TsMorphNode.isCallExpression(decl)) {
      declInfo.name = decl.getExpression().getText();
      declInfo.type = 'TEST_CASE';
    } else if (TsMorphNode.isMethodDeclaration(decl)) {
      declInfo.name = decl.getName();
      declInfo.type = 'METHOD';
    } 

    return declInfo;
  }

  private async loadDocuments() {
    const loader = new DirectoryLoader(
      process.env.REPO_PATH || '',
      { '.ts': (path) => new TextLoader(path),
        '.js': (path) => new TextLoader(path),
      },
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

  private async addDiffHunkNode(decl: Statement | MethodDeclaration | CallExpression, declUuid: string, relativeRepoPath: string) {
    const diffHunksForFile = this.nodes.filter(node => node.type === 'DIFF_HUNK' && node.properties?.source === relativeRepoPath);

    if (diffHunksForFile.length === 0) {
      return;
    }

    const declStartLine = decl.getStartLineNumber();
    const declEndLine = decl.getEndLineNumber();

    for (const hunk of diffHunksForFile) {
      const hunkOverlapsDecl = 
        hunk.properties?.overLapStartLine <= declEndLine && hunk.properties?.overLapEndLine >= declStartLine ||
        hunk.properties?.overLapStartLine >= declStartLine && hunk.properties?.overLapEndLine <= declEndLine;

      if (hunkOverlapsDecl) {
        const diffUuid = this.getOrCreateUuid('' + hunk.properties?.startLine + hunk.properties?.endLine, relativeRepoPath);
        const declInfo = await this.getDeclarationName(decl);

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

  private async parseTypeScriptFile(filePath: string, content: string) {
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
            content: cls.getText(),
            source: relativeRepoPath,
          }
        })
      );

      await this.addDiffHunkNode(cls, classUuid, relativeRepoPath);

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
              content: baseClass.getText(),
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
              content: impl.getText(),
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

      await this.extractMethods(cls, classUuid);
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
            content: iface.getText(),
            source: relativeRepoPath,
          }
        })
      );

      await this.addDiffHunkNode(iface, interfaceUuid, relativeRepoPath);

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
                  content: baseDecl.getText(),
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
            content: func.getText(),
            source: relativeRepoPath,
          }
        })
      );

      await this.addDiffHunkNode(func, functionUuid, relativeRepoPath);
      await this.extractMethodCalls(func, functionUuid);
      await this.extractFunctionCalls(func, functionUuid);
    }

    await this.extractTestCases(sourceFile, relativeRepoPath);

    return new GraphDocument({
      nodes: this.nodes,
      relationships: this.relationships,
      source: new Document({ pageContent: content, metadata: { source: filePath } }),
    });
  }

  private async extractMethods(
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
            content: method.getText(),
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

      await this.addDiffHunkNode(method, methodUuid, relativeSourcePath);
      await this.extractMethodCalls(method, methodUuid);
      await this.extractFunctionCalls(method, methodUuid);
    }
  }

  private async extractMethodCalls(decl: MethodDeclaration | FunctionDeclaration, declUuid: string) {
    const references = decl.findReferencesAsNodes();
    const declInfo = await this.getDeclarationName(decl);

    for (const reference of references) {
      const callingDecl = reference.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);

      if (callingDecl) {
        const callingDeclName = callingDecl.getName();
        const callingDeclInfo = await this.getDeclarationName(callingDecl);

        if (!callingDeclName) {
          continue;
        }

        const paramTypes = callingDecl.getParameters()
          .map(param => param.getType().getText());
        const relativeSourcePath = path.relative(process.env.REPO_PATH || '', callingDecl.getSourceFile().getFilePath());
        const callerUuid = this.getOrCreateUuid(callingDeclName + paramTypes, relativeSourcePath);

        this.addNodeIfNew(
          new Node({
            id: callerUuid,
            type: callingDeclInfo.type,
            properties: {
              name: callingDeclName,
              content: callingDecl.getText(),
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
      const callingDecl = reference.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration);

      if (callingDecl) {
        const methodName = callingDecl.getName();
        const callingDeclInfo = await this.getDeclarationName(callingDecl);

        if (!methodName) {
          continue;
        }

        const paramTypes = callingDecl.getParameters()
          .map(param => param.getType().getText());
        const relativeSourcePath = path.relative(process.env.REPO_PATH || '', callingDecl.getSourceFile().getFilePath());
        const callerUuid = this.getOrCreateUuid(methodName + paramTypes, relativeSourcePath);

        this.addNodeIfNew(
          new Node({
            id: callerUuid,
            type: callingDeclInfo.type,
            properties: {
              name: methodName,
              content: callingDecl.getText(),
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

  private async extractTestCases(sourceFile: SourceFile, relativeRepoPath: string) {
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    
    for (const callExpr of callExpressions) {
      if (!this.isTestCall(callExpr)) {
        continue;
      }
      
      const testName = this.extractTestName(callExpr);

      if (!testName) {
        continue;
      }
      
      const testUuid = this.getOrCreateUuid(testName, relativeRepoPath);
      
      this.addNodeIfNew(
        new Node({
          id: testUuid,
          type: 'TEST_CASE',
          properties: { 
            name: testName,
            content: callExpr.getText(),
            source: relativeRepoPath
          }
        })
      );
      
      await this.addDiffHunkNode(callExpr, testUuid, relativeRepoPath);
    }
  }

  private isTestCall(callExpr: CallExpression) {
    const text = callExpr.getExpression().getText();
    const testPatterns = ['describe', 'test', 'it'];
    
    return testPatterns.some(pattern => 
      text === pattern
    );
  }

  private extractTestName(callExpr: CallExpression) {
    const text = callExpr.getExpression().getText();
    const args = callExpr.getArguments();

    if (args.length === 0 || args[0].getKind() !== SyntaxKind.StringLiteral) {
      return null;
    }

    const fullTestName = text + ':' + args[0].getText().slice(1, -1);

    return fullTestName;
  }

  filterGraph(hops: number) {
    const affectedNodeIds = new Set<string>();

    for (const relationship of this.relationships) {
      if (relationship.type === 'HAS_DIFF') {
        affectedNodeIds.add(String(relationship.source.id));
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

    for (const node of this.nodes) {
      if (node.type === 'DIFF_HUNK') {
        affectedNodeIds.add(String(node.id));
      }
    }

    const filteredNodes = this.nodes.filter(node => affectedNodeIds.has(String(node.id)));
    const filteredRelationships = this.relationships.filter(relationship => 
      (affectedNodeIds.has(String(relationship.source.id)) &&
      affectedNodeIds.has(String(relationship.target.id)))
    );

    return new GraphDocument({
      nodes: filteredNodes,
      relationships: filteredRelationships,
      source: new Document({ pageContent: `Filtered Graph with ${hops} hops`, metadata: {} }),
    });
  }

  createDiffHunkNodes(diffDetails: DiffDetails[]) {
    for (const diffFile of diffDetails) {
      const relativeRepoPath = diffFile.filePath || '';
      for (const hunk of diffFile.hunks) {
        
        const addedLines = hunk.content
          .filter(line => line.startsWith('+'))
          .map(line => line.slice(1));
        const removedLines = hunk.content
          .filter(line => line.startsWith('-'))
          .map(line => line.slice(1));

        const firstAddedOrRemovedIndex = hunk.content
          .findIndex(line => line.startsWith('+') || line.startsWith('-'));

        let lastAddedOrRemovedLineIndex = -1
        for (let i = hunk.content.length - 1; i >= 0; i--) {
          if (hunk.content[i].startsWith('+') || hunk.content[i].startsWith('-')) {
            lastAddedOrRemovedLineIndex = i;
            break;
          }
        }

        const diffUuid = this.getOrCreateUuid('' + hunk.startLine + hunk.endLine, relativeRepoPath);

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
              overLapStartLine: hunk.startLine + firstAddedOrRemovedIndex,
              overLapEndLine: hunk.startLine + lastAddedOrRemovedLineIndex,
              source: relativeRepoPath,
            }
          })
        );
      }
    }
  }

  async clearGraph() {
    const graph = await this.getGraphClient();
    await graph.query('MATCH (n) DETACH DELETE n');

    logger.info('Graph cleared successfully');
  }

  async buildGraph(diffDetails: DiffDetails[], hops: number = 3) {
    logger.info('Starting Neo4j graph database setup');

    await this.clearGraph();

    this.createDiffHunkNodes(diffDetails);
    
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
        const graphDoc = await this.parseTypeScriptFile(filePath, content);

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
      const graph = await this.getGraphClient();

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
