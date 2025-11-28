import { BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Annotation, END, messagesStateReducer, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { createAiModel, CreateModelOptions, ToolReadyChatModel, AiProvider } from '../../lib/ai-core';
import { RunnableLambda } from '@langchain/core/runnables';
import { z } from 'zod';
import { ModelJobsOutput, ModelReviewCheckerOutput, ModelReviewsOutput, ModelSecurityScanOutput, logger } from '../../lib/ai-utils';

export abstract class BaseAgent {
	private readonly llm: ToolReadyChatModel;
	protected readonly abstract tools: any[];
  protected readonly abstract systemMessage: string;
  protected readonly abstract outputSchema: z.ZodObject;

  constructor(opts: CreateModelOptions) {
		try {
			this.llm = createAiModel({
				provider: opts.provider,
				model: opts.model,
				temperature: opts.temperature,
			});
		} catch (error) {
			logger.error({ err: error, provider: opts.provider }, 'Error creating AI model');
			logger.info('Falling back to default provider: google');

			this.llm = createAiModel({
				provider: AiProvider.Google,
			});
		}
	}

  public async getAgent() {
    const agentAnnotation = Annotation.Root({
			messages: Annotation<BaseMessage[]>({
				default: () => [
          new SystemMessage(this.systemMessage),
        ],
        reducer: messagesStateReducer
      }),
      modelOutput: Annotation<ModelJobsOutput[] | ModelReviewsOutput[] | 
      ModelSecurityScanOutput[] | ModelReviewCheckerOutput[]>({
        default: () => [],
        reducer: (_x, y) => y,
      })
    });

    const validatedRunnable = RunnableLambda.from(async (input: typeof agentAnnotation.State) => {
      const runnableWithTools = this.llm.bindTools(this.tools);
      const response = await runnableWithTools.invoke(input.messages);
      const completionTokens =
        response.usage_metadata?.output_tokens ??
        response.response_metadata?.usage?.output_tokens ??
        response.response_metadata?.tokenUsage?.completionTokens;

      if (completionTokens === 0) {
        throw new Error('ZeroOutputTokensError');
      }

      return response;
    });

    const callModel = async (state: typeof agentAnnotation.State) => {
      const response = await validatedRunnable.withRetry({ stopAfterAttempt: 3 }).invoke(state);

      return { messages: response };
    };

    const callModelWithStructuredOutput = async (state: typeof agentAnnotation.State) => {
      const runnableWithStructuredOutput = this.llm.withStructuredOutput(this.outputSchema);
      const last = state.messages[state.messages.length - 1];
      let content = '';

      if (typeof last.content === 'string') {
        content = last.content;
      } else if (Array.isArray(last.content)) {
        content = last.content
          .filter((block): block is { type: 'text'; text: string } => 
            block.type === 'text' && 'text' in block
          )
          .map(block => block.text)
          .join('\n');
      };

      const response = await runnableWithStructuredOutput.withRetry({ stopAfterAttempt: 3 }).invoke([
        new SystemMessage(
          'You are a JSON extraction assistant. Your job is to take the input content and convert it into the required JSON schema format.' +
          'CRITICAL RULES:\n' +
          '1. Do NOT add explanatory text, summaries, or additional fields\n' +
          '2. Simply extract and structure the data provided into the schema\n' +
          '3. If the input is already valid JSON matching the schema, output it exactly as-is\n' +
          '4. You MUST fix formatting issues to ensure valid JSON:\n' +
          '   - Remove markdown code blocks (```) from string values\n' +
          '   - Properly escape special characters (newlines, quotes, backslashes)\n' +
          '   - Ensure the output is strictly valid JSON'
        ),
        new HumanMessage(
          'Extract the following content into the required JSON schema format. ' +
          'Output ONLY the JSON array with no additional text or explanation:\n\n' +
          `${content}`
        )
      ]);

      return { modelOutput: response.items };
    };

    const shouldContinue = (state: typeof agentAnnotation.State) => {
      const last = state.messages[state.messages.length - 1];

      if ('tool_calls' in last && Array.isArray(last.tool_calls) && last.tool_calls.length) {
        return 'tools';
      }

      return 'structured_output';
    };

    const agentGraph = new StateGraph(agentAnnotation)
      .addNode('agent', callModel)
      .addNode('tools', new ToolNode(this.tools))
      .addNode('structured_output', callModelWithStructuredOutput)
      .addEdge(START, 'agent')
      .addConditionalEdges('agent', shouldContinue, 
        ['tools', 'structured_output']
      )
      .addEdge('tools', 'agent')
      .addEdge('structured_output', END);

    const agent = agentGraph.compile();

    return agent;
  }
}