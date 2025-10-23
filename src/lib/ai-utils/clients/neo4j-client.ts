import { Neo4jGraph } from '@langchain/community/graphs/neo4j_graph';
import { logger } from '../logger';

export class Neo4jClient {
  private static _client: Neo4jGraph;

  private constructor() {}

  public static async getClient() {
    if (!this._client) {
      this._client = await this.initializeClient();
    }

    return this._client;
  }

  private static async initializeClient() {
    try {
      const url = process.env.NEO4J_URL || '';
      const username = process.env.NEO4J_USER || '';
      const password = process.env.NEO4J_PASSWORD || '';

      const client = await Neo4jGraph.initialize({
        url,
        username,
        password,
      });
      
      logger.info('Neo4j client initialized successfully');

      return client;
    } catch (error) {
      logger.error({ err: error }, 'Error initializing Neo4j client');
      throw error;
    }
  }

  public static async close() {
    if (this._client) {
      await this._client.close();
      logger.info('Neo4j client closed');
    }
  }
}