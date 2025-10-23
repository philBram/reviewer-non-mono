import { Neo4jVectorStore } from '@langchain/community/vectorstores/neo4j_vector';
import { createEmbeddingModel, CreateEmbeddingModelOptions } from '../../ai-core';
import { logger } from '../logger';

export class Neo4jVectorStoreClient {
  private static _client: Neo4jVectorStore;

  private constructor() {}

  public static async getClient(createEmbeddingModelOptions: CreateEmbeddingModelOptions) {
    if (!this._client) {
      this._client = await this.initializeClient(createEmbeddingModelOptions);
    }

    return this._client;
  }

  private static async initializeClient(createEmbeddingModelOptions: CreateEmbeddingModelOptions) {
    try {
      logger.debug('Initializing Neo4j Vector Store client');
      const config = {
        url: process.env.NEO4J_URL || '',
        username: process.env.NEO4J_USER || '',
        password: process.env.NEO4J_PASSWORD || '',
        indexName: 'diff_vector_index',
        keywordIndexName: 'diff_keyword_index',
        searchType: 'hybrid' as const,
        nodeLabel: 'DIFF_HUNK',
        textNodeProperties: ['id', 'content', 'added_lines', 'removed_lines', 'start_line', 'end_line', 'source'],
        embeddingNodeProperty: 'embedding',
        retrievalQuery: `
          RETURN node.content AS text, 
            node.id AS id,
            node.source AS source, 
            node.start_line AS start_line, 
            node.end_line AS end_line, 
            node.added_lines AS added_lines, 
            node.removed_lines AS removed_lines,
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