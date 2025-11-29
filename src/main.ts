import { AiProvider, EmbeddingProvider, ReasoningOptions } from './lib/ai-core/index';
import { CreateOrchestratorModelsOptions, OrchestratorAgent } from './agents/orchestrator-agent/orchestrator-agent';
import * as dotenv from 'dotenv';
import { Neo4jClient, Neo4jVectorStoreClient, WeaviateVectorClient, logger } from './lib/ai-utils/index';
import { postPullRequestReviewComments } from './setup/github-setup/github-setup';

dotenv.config();

export async function main() {
	const graphDeps = 0;
	const reviewCheck = true;
	const reviewCheckLimit = 5;
	const runInParallel = true;
	const recursionLimit = 200;
	const additionalSecurityScan = true;

	const createOrchestratorModelsOptions = {
		embeddingOpts: {
			provider: EmbeddingProvider.Google,
		},
		securityScannerOpts: {
			provider: AiProvider.Google,
			model: 'gemini-2.5-flash',
			temperature: 0.2,
		},
		plannerOpts: {
			provider: AiProvider.Google,
			model: 'gemini-2.5-pro',
			temperature: 0.3,
		},
		reviewerOpts: {
			provider: AiProvider.Google,
			model: 'gemini-2.5-pro',
			temperature: 0.3,
		},
		reviewCheckerOpts: {
			provider: AiProvider.Google,
			model: 'gemini-2.5-pro',
			temperature: 0.3,
		},
		graphDeps,
		reviewCheck,
		reviewCheckLimit,
		runInParallel,
		additionalSecurityScan,
		recursionLimit,
	} as CreateOrchestratorModelsOptions;

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

		logger.info('All connections closed.');

		process.exit(0);
	}
}

main().catch(err => {
	logger.error({ err }, 'Fatal error in main()');
	process.exit(1);
});