import weaviate, { WeaviateClient as Client } from 'weaviate-client';
import { logger } from '../logger';

export class WeaviateVectorClient {
  private static _client: Client;

  private constructor() {}

  /*public static async getClient() {
    if (!this._client) {
      this._client = await this.initializeClient();
    }

    return this._client;
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
  }*/
}