import { AiProvider, EmbeddingProvider, ReasoningOptions } from './lib/ai-core/index';
import { OrchestratorAgent } from './agents/orchestrator-agent/orchestrator-agent';
import * as dotenv from 'dotenv';
import { MCPTools } from './lib/ai-tools/index';
import { Neo4jClient, Neo4jVectorStoreClient, WeaviateVectorClient, logger } from './lib/ai-utils/index';
import { postPullRequestReviewComments } from './setup/github-setup/github-setup';

dotenv.config();

export async function main() {
	const reviewCheck = true;
	const runInParallel = true;
	const recursionLimit = 200;
	const additionalSecurityScan = false;

	const createOrchestratorModelsOptions = {
		embeddingOpts: {
			provider: EmbeddingProvider.Azure,
		},
		securityScannerOpts: {
			provider: AiProvider.Azure, 
			temperature: 0.2,
			reasoning: ReasoningOptions.minimal,
		},
		plannerOpts: {
			provider: AiProvider.Azure,
			temperature: 0.4,
			reasoning: ReasoningOptions.medium,
		},
		reviewerOpts: {
			provider: AiProvider.Azure,
			temperature: 0.3,
			reasoning: ReasoningOptions.high,
		},
		reviewCheck,
		runInParallel,
		additionalSecurityScan,
		recursionLimit,
	};

	const orchestrator = new OrchestratorAgent(
		createOrchestratorModelsOptions, 
	);

	const orchestratorAgent = await orchestrator.getAgent();

	try {
		logger.info('Orchestrator agent started.');
		const result = await orchestratorAgent.invoke({}, { recursionLimit });
		
		const reviewOutput = result.modelReviewOutput;
		logger.info(reviewOutput);
		
		if (reviewOutput && reviewOutput.length > 0) {
			logger.info({ count: reviewOutput.length }, 'Processing review items for GitHub');
			await postPullRequestReviewComments(reviewOutput);
		} else {
			logger.info('No review items to post.');
		}

		logger.info({ reviewCount: result.modelReviewOutput?.length || 0 }, 'Code review completed successfully');
	} catch (error) {
		logger.error({ err: error }, 'Error invoking orchestrator agent');
		throw error;
	}
	finally {
		await WeaviateVectorClient.close();
		await Neo4jVectorStoreClient.close();
		await Neo4jClient.close();
		await MCPTools.close();

		logger.info('All connections closed.');

		process.exit(0);
	}
}

main().catch(err => {
	logger.error({ err }, 'Fatal error in main()');
	process.exit(1);
});