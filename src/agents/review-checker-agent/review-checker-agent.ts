import { AdditionalMCPTools, BaseAgent } from '../base-agent/base-agent';
import { CreateModelOptions } from '../../lib/ai-core';
import { reviewCheckerAgentSystemMessage } from '../../agent-system-messages/agent-system-messages';
import { reviewCheckerSchema } from '../../lib/ai-utils';

export class ReviewCheckerAgent extends BaseAgent {
	protected readonly tools: any[];
	protected readonly systemMessage = reviewCheckerAgentSystemMessage;
	protected readonly outputSchema = reviewCheckerSchema;
	protected readonly additionalMCPTools = AdditionalMCPTools.None;

	constructor(
		opts: CreateModelOptions, 
	) {
		super(opts);

		this.tools = [];
	}
} 
