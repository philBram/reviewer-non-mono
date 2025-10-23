import { WeaviateStore } from '@langchain/weaviate';
import { Embeddings } from '@langchain/core/embeddings';
import { createEmbeddingModel, CreateEmbeddingModelOptions } from '../../lib/ai-core';
import { DirectoryLoader } from 'langchain/document_loaders/fs/directory';
import { TextLoader } from 'langchain/document_loaders/fs/text';
import { WeaviateVectorClient, logger } from '../../lib/ai-utils';
import { Project } from 'ts-morph';
import { Document } from '@langchain/core/documents';
import * as path from 'path';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

export class WeaviateVectorDbSetup {
  private readonly ignoreRegex = /node_modules|\/dist\/|\/build\/|\.spec\.ts$|\.d\.ts$|jest.*\.ts$|\.ya?ml$|\.json$/;
  private readonly collectionName: string;
  private readonly embeddingModel: Embeddings;
  private readonly project: Project;

  constructor(createEmbeddingModelOptions: CreateEmbeddingModelOptions) {
    this.embeddingModel = createEmbeddingModel(createEmbeddingModelOptions);
    this.collectionName = `${createEmbeddingModelOptions.provider}_embeddings`;
    this.project = new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
      },
    });
  }

  private async getClient() {
    return await WeaviateVectorClient.getClient();
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

  private async parseTypeScriptFile(filePath: string, content: string) {
    const sourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });
    const relativeRepoPath = path.relative(process.env.REPO_PATH || '', filePath);
    const documents: Document[] = [];

    for (const cls of sourceFile.getClasses()) {
      const className = cls.getName();

      if (!className) {
        continue;
      }

      documents.push(new Document({
        pageContent: cls.getText(),
        metadata: {
          name: className,
          type: 'CLASS',
          parent: '',
          start_line: cls.getStartLineNumber(),
          end_line: cls.getEndLineNumber(),
          source: relativeRepoPath,
        }
      }));

      for (const method of cls.getMethods()) {
        const methodName = method.getName();

        documents.push(new Document({
          pageContent: method.getText(),
          metadata: {
            name: methodName,
            type: 'METHOD',
            parent: className,
            start_line: method.getStartLineNumber(),
            end_line: method.getEndLineNumber(),
            source: relativeRepoPath,
          }
        }));
      }
    }

    for (const iface of sourceFile.getInterfaces()) {
      const interfaceName = iface.getName();

      if (!interfaceName) {
        continue;
      }

      documents.push(new Document({
        pageContent: iface.getText(),
        metadata: {
          name: interfaceName,
          type: 'INTERFACE',
          parent: '',
          start_line: iface.getStartLineNumber(),
          end_line: iface.getEndLineNumber(),
          source: relativeRepoPath,
        }
      }));
    }

    for (const func of sourceFile.getFunctions()) {
      const functionName = func.getName();

      if (!functionName) {
        continue;
      }

      documents.push(new Document({
        pageContent: func.getText(),
        metadata: {
          name: functionName,
          type: 'FUNCTION',
          parent: '',
          start_line: func.getStartLineNumber(),
          end_line: func.getEndLineNumber(),
          source: relativeRepoPath,
        }
      }));
    }

    this.project.removeSourceFile(sourceFile);
    return documents;
  }

  private async clearIndex() {
    const client = await this.getClient();
    await client.collections.deleteAll();

    logger.info('Weaviate collections deleted successfully');
  }

  async storeInWeaviate() {
    logger.info('Starting Weaviate vector database setup');
    const client = await this.getClient();
    await this.clearIndex();
    const documents = await this.loadDocuments();

    logger.info({ documentCount: documents.length }, 'Documents loaded for weaviate');
    
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 2000,
      chunkOverlap: 200,
      separators: ['\n\n', '\n', ' ', ''],
    });

    logger.debug('Starting document chunking and AST parsing');
    const allChunkedDocuments: Document[] = [];

    for (const doc of documents) {
      const filePath = doc.metadata?.source;
      const content = doc.pageContent;

      const astDocuments = await this.parseTypeScriptFile(filePath, content);
      
      for (const astDoc of astDocuments) {
        const chunks = await splitter.splitDocuments([astDoc]);
        allChunkedDocuments.push(...chunks);
      }
    }

    logger.info({ totalChunks: allChunkedDocuments.length }, 'Chunking completed');

    try {
      logger.debug({ collection: this.collectionName, chunkCount: allChunkedDocuments.length }, 'Storing documents in Weaviate');
      
      await WeaviateStore.fromDocuments(
        allChunkedDocuments,
        this.embeddingModel,
        {
          client: client,
          indexName: this.collectionName,
          textKey: 'text',
          metadataKeys: ['name', 'type', 'parent', 'start_line', 'end_line', 'source'],
        }
      );

      logger.info({ count: allChunkedDocuments.length, collection: this.collectionName }, 'Successfully stored all documents in Weaviate');
    } catch (error) {
      logger.error({ err: error, collection: this.collectionName }, 'Error storing documents in Weaviate');
      throw error;
    }
  }
}
