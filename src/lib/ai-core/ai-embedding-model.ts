import { MistralAIEmbeddings } from '@langchain/mistralai';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { AzureOpenAIEmbeddings, OpenAIEmbeddings } from '@langchain/openai';
import { Embeddings } from '@langchain/core/embeddings';

export enum EmbeddingProvider {
  Google = 'google',
  OpenAi = 'openai',
  Mistral = 'mistral',
  Azure = 'azure',
}

export interface CreateEmbeddingModelOptions {
  provider: EmbeddingProvider;
  model?: string;
}

type EmbeddingFactory = (opts: Omit<CreateEmbeddingModelOptions, 'provider'>) => Embeddings;

const EMBEDDING_FACTORIES: Record<EmbeddingProvider, EmbeddingFactory> = {
  [EmbeddingProvider.OpenAi]: ({ model }) =>
    new OpenAIEmbeddings({
      model: model ?? 'text-embedding-3-small',
    }),
  [EmbeddingProvider.Google]: ({ model }) =>
    new GoogleGenerativeAIEmbeddings({
      model: model ?? 'text-embedding-004',
    }),
  [EmbeddingProvider.Mistral]: ({ model }) =>
    new MistralAIEmbeddings({
      model: model ?? 'mistral-embed',
    }),
  [EmbeddingProvider.Azure]: ({ model }) => {
    const embeddingModel = model ?? 'text-embedding-3-small';

    return new AzureOpenAIEmbeddings({
      model: embeddingModel,
      azureOpenAIApiDeploymentName: embeddingModel,
    });
  }
};

export function createEmbeddingModel(opts: CreateEmbeddingModelOptions): Embeddings {
  const { provider, ...rest } = opts;
  const factory = EMBEDDING_FACTORIES[provider];

  if (!factory) {
    throw new Error(`Unsupported embedding provider: ${provider}`);
  }

  return factory(rest);
}
