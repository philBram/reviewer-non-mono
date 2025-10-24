import weaviate, { WeaviateClient as Client } from 'weaviate-client';
import { Mutex } from 'async-mutex';
import { logger } from '../logger';

export class WeaviateVectorClient {
  private static _client: Client;
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
      const client = await weaviate.connectToLocal({
        host: process.env.WEAVIATE_HOST || 'localhost',
        port: parseInt(process.env.WEAVIATE_PORT || '8080'),
        grpcPort: parseInt(process.env.WEAVIATE_GRPC_PORT || '50051'),
      });

      logger.info({ host: process.env.WEAVIATE_HOST || 'localhost', port: process.env.WEAVIATE_PORT || '8080' }, 'Weaviate client initialized successfully');

      return client;
    } catch (error) {
      logger.error({ err: error }, 'Error initializing Weaviate client');
      throw error;
    }
  }

  public static async close() {
    if (this._client) {
      await this._client.close();
      logger.info('Weaviate client closed');
    }
  }
}