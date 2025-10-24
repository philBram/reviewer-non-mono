import { AdditionalMCPTools, BaseAgent } from '../base-agent/base-agent';
import { CreateEmbeddingModelOptions, CreateModelOptions } from '../../lib/ai-core';
import { getFileContent, WeaviateVectorDbTools, Neo4jGraphDbTools, searchCode } from '../../lib/ai-tools';
import { reviewAgentSystemMessage } from '../../agent-system-messages/agent-system-messages';
import { reviewsSchema } from '../../lib/ai-utils';

export class ReviewAgent extends BaseAgent {
	private readonly neo4jGraphDb: Neo4jGraphDbTools;
	private readonly weaviateVectorDb: WeaviateVectorDbTools;
	protected readonly tools: any[];
	protected readonly systemMessage = reviewAgentSystemMessage;
	protected readonly outputSchema = reviewsSchema;
	protected readonly additionalMCPTools = AdditionalMCPTools.None;

	constructor(
		opts: CreateModelOptions, 
		embeddingOpts: CreateEmbeddingModelOptions, 
	) {
		super(opts);

		this.weaviateVectorDb = new WeaviateVectorDbTools(embeddingOpts);
		this.neo4jGraphDb = new Neo4jGraphDbTools();

		this.tools = this.getTools();
	}

  private getTools() {
		return [
			searchCode(),
			getFileContent(),
			this.neo4jGraphDb.findDiffHunk(),
			this.neo4jGraphDb.findAffectedDeclarations(),
			this.neo4jGraphDb.findImpactedDeclarations(),
		];
  }
} 
