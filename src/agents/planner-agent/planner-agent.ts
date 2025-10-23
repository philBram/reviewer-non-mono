import { Neo4jGraphDbTools } from '../../lib/ai-tools';
import { AdditionalMCPTools, BaseAgent } from '../base-agent/base-agent';
import { CreateModelOptions } from '../../lib/ai-core';
import { plannerAgentSystemMessage } from '../../agent-system-messages/agent-system-messages';
import { jobsSchema } from '../../lib/ai-utils';

export class PlannerAgent extends BaseAgent {
	private readonly neo4jGraphDb: Neo4jGraphDbTools;
	protected readonly tools: any[];
	protected readonly systemMessage = plannerAgentSystemMessage;
	protected readonly outputSchema = jobsSchema;
	protected readonly additionalMCPTools = AdditionalMCPTools.None;

	constructor(opts: CreateModelOptions) {
		super(opts);

		this.neo4jGraphDb = new Neo4jGraphDbTools();

    this.tools = this.getTools();
	}

  private getTools() {
		return [
			this.neo4jGraphDb.findChanges(),
			this.neo4jGraphDb.findImpactedDeclarations(),
		];
  }
}