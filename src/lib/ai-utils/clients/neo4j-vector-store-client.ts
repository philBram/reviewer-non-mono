import { Neo4jVectorStore } from '@langchain/community/vectorstores/neo4j_vector';
import { createEmbeddingModel, CreateEmbeddingModelOptions } from '../../ai-core';
import { Mutex } from 'async-mutex';
import { logger } from '../logger';

export class Neo4jVectorStoreClient {
  private static _client: Neo4jVectorStore;
  private static _mutex = new Mutex();

  private constructor() {}

  public static async getClient(createEmbeddingModelOptions: CreateEmbeddingModelOptions) {
    if (this._client) {
      return this._client;
    }

    return this._mutex.runExclusive(async () => {
      if (this._client) {
        return this._client;
      }

      const client = await this.initializeClient(createEmbeddingModelOptions);
      this._client = client;

      return client;
    });
  }

  private static async initializeClient(createEmbeddingModelOptions: CreateEmbeddingModelOptions) {
    try {
      const config = {
        url: process.env.NEO4J_URL || '',
        username: process.env.NEO4J_USER || '',
        password: process.env.NEO4J_PASSWORD || '',
        indexName: 'diff_vector_index',
        keywordIndexName: 'diff_keyword_index',
        searchType: 'hybrid' as const,
        nodeLabel: 'DIFF_HUNK',
        textNodeProperties: ['id', 'content', 'addedLines', 'removedLines', 'startLine', 'endLine', 'source'],
        embeddingNodeProperty: 'embedding',
        retrievalQuery: `
          RETURN node.content AS text, 
            node.id AS id,
            node.source AS source, 
            node.startLine AS startLine, 
            node.endLine AS endLine, 
            node.addedLines AS addedLines, 
            node.removedLines AS removedLines,
            score
        `
      };

      const client = await Neo4jVectorStore.fromExistingGraph(
        createEmbeddingModel(createEmbeddingModelOptions),
        config,
      );
      
      logger.info('Neo4j Vector Store client initialized successfully');

      return client;
    } catch (error) {
      logger.error({ err: error }, 'Error connecting to Neo4j Vector Store');
      throw error;
    }
  }

  public static async close() {
    if (this._client) {
      await this._client.close();
      logger.info('Neo4j Vector Store client closed');
    }
  }
}