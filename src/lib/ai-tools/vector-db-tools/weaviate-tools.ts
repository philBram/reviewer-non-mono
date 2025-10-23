import { WeaviateStore } from '@langchain/weaviate';
import { Embeddings } from '@langchain/core/embeddings';
import { createEmbeddingModel, CreateEmbeddingModelOptions } from '../../ai-core';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { WeaviateVectorClient } from '../../ai-utils';
import { WeaviateClient } from 'weaviate-client';

export class WeaviateVectorDbTools {
  private readonly collectionName: string;
  private readonly embeddingModel: Embeddings;
  private readonly vectorClient: Promise<WeaviateClient>;

  constructor(createEmbeddingModelOptions: CreateEmbeddingModelOptions) {
    this.embeddingModel = createEmbeddingModel(createEmbeddingModelOptions);
    this.collectionName = `${createEmbeddingModelOptions.provider}_embeddings`;
    this.vectorClient = WeaviateVectorClient.getClient();
  }

  hybridSearch() {
    const schema = z.object({
      query: z.string().describe('Natural language query to search the codebase (semantic or keyword).'),
      topK: z.number().min(1).max(20).default(10).describe('Max number of results (must be >= 1)'),
      alpha: z.number().min(0).max(1).default(0).describe('Weight for the vector search (0.0 to 1.0, where 0.0=keyword, 1.0=semantic)'),
      threshold: z.number().min(0.5).max(0.7).default(0.6).describe('Minimum score threshold (0.5 to 0.7) to filter results'),
    });
    return tool(
      async (input) => {
        const { query, topK, alpha, threshold } = schema.parse(input);
        const client = await this.vectorClient;
        const vectorStore = await WeaviateStore.fromExistingIndex(
          this.embeddingModel,
          {
            client: client,
            indexName: this.collectionName,
            textKey: 'text',
            metadataKeys: ['name', 'type', 'parent', 'start_line', 'end_line', 'source'],
          }
        );

        const raw = await vectorStore.hybridSearch(query, {
          limit: topK,
          alpha: alpha,
        });

        const results = raw
        .filter((doc) => doc.metadata.score >= threshold)
        .map(doc => ({
          content: doc.pageContent,
          source: doc.metadata.source,
          metadata: doc.metadata,
        })); 

        return JSON.stringify({
          query,
          returned: results.length,
          results: results,
        }, null, 2);
      },
      {
        name: 'hybrid_search_weaviate',
        description: 'Search the codebase (for patterns, classes, functions, methods, variables, etc.) using hybrid search (combines semantic vector search and keyword/BM25 search). Use alpha to control the balance: alpha=0 for pure keyword search (best for exact terms like class/function names), alpha=1 for pure semantic search (best for concepts), alpha=0.5 for balanced hybrid search. Returns relevant code snippets with their file paths.',
        schema: schema,
      }
    );
  }
}
