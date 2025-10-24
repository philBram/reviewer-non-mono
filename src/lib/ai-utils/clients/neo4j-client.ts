import { Neo4jGraph } from '@langchain/community/graphs/neo4j_graph';
import { Mutex } from 'async-mutex';
import { logger } from '../logger';

export class Neo4jClient {
  private static _client: Neo4jGraph;
  private static _mutex = new Mutex();

  private constructor() {}

  public static async getClient() {
    if (this._client) {
      return this._client;
    }

    return this._mutex.runExclusive(async () => {
      if (this._client) {
        return this._client;
      }

      const client = await this.initializeClient();
      this._client = client;

      return client;
    });
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