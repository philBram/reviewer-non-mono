import { AdditionalMCPTools, BaseAgent } from '../base-agent/base-agent';
import { CreateModelOptions } from '../../lib/ai-core';
import { getFileContent } from '../../lib/ai-tools';
import { securityScannerAgentSystemMessage } from '../../agent-system-messages/agent-system-messages';
import { securityScanSchema } from '../../lib/ai-utils';

export class SecurityScannerAgent extends BaseAgent {
	protected readonly tools: any[];
	protected readonly systemMessage = securityScannerAgentSystemMessage;
	protected readonly outputSchema = securityScanSchema;
	protected readonly additionalMCPTools = AdditionalMCPTools.Semgrep;

	constructor(
		opts: CreateModelOptions, 
	) {
		super(opts);

		this.tools = this.getTools();
	}

  private getTools() {
		return [
			getFileContent(),
		];
  }
} 
