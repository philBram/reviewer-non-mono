import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatMistralAI } from '@langchain/mistralai';
import { AzureChatOpenAI, ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';

export enum AiProvider {
  Google = 'google',
  Anthropic = 'anthropic',
  OpenAi = 'openai',
  Mistral = 'mistral',
  OpenRouter = 'openrouter',
  Azure = 'azure',
};

export interface CreateModelOptions {
  provider: AiProvider;
  model?: string;
  temperature?: number;
}

export interface ToolReadyChatModel extends BaseChatModel {
  bindTools: NonNullable<BaseChatModel['bindTools']>;
}

type Factory = (opts: Omit<CreateModelOptions, 'provider'>) => BaseChatModel;

const FACTORIES: Record<AiProvider, Factory> = {
  [AiProvider.Google]: ({ model, temperature }) =>
    new ChatGoogleGenerativeAI({
      model: model ?? 'gemini-2.5-flash',
      temperature: temperature ?? 0.7,
    }),
  [AiProvider.Anthropic]: ({ model, temperature }) =>
    new ChatAnthropic({
      model: model ?? 'claude-sonnet-4-5',
      temperature: temperature ?? 0.7,
    }),
  [AiProvider.OpenAi]: ({ model, temperature }) =>
    new ChatOpenAI({
      model: model ?? 'gpt-5-mini',
      temperature: temperature ?? 0.7,
    }),
  [AiProvider.Mistral]: ({ model, temperature }) =>
    new ChatMistralAI({
      model: model ?? 'mistral-large-latest',
      temperature: temperature ?? 0.7,
    }),
  [AiProvider.OpenRouter]: ({ model, temperature }) =>
    new ChatOpenAI(
    {
      model: model ?? 'microsoft/mai-ds-r1:free',
      temperature: temperature ?? 0.7,
      apiKey: process.env['OPENROUTER_API_KEY'] ?? '',
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1'
      },
    }),
  [AiProvider.Azure]: ({ model, temperature }) => {
    const azureModel = model ?? 'gpt-4o-mini';

    return new AzureChatOpenAI({
      model: azureModel,
      temperature: temperature ?? 0.7,
      azureOpenAIApiDeploymentName: azureModel,
    });
  },
};

export function createAiModel(opts: CreateModelOptions): ToolReadyChatModel {
  const { provider, ...rest } = opts;
  const factory = FACTORIES[provider];

  if (!factory) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const model = factory(rest);

  if (typeof (model as ToolReadyChatModel).bindTools !== 'function') {
    throw new Error('bindTools not supported');
  }

  return model as ToolReadyChatModel;
}
