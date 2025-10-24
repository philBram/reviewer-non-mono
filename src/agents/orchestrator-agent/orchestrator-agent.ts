import { CreateEmbeddingModelOptions, CreateModelOptions } from '../../lib/ai-core';
import { PlannerAgent } from '../planner-agent/planner-agent';
import { ReviewAgent } from '../review-agent/review-agent';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import { WeaviateVectorDbSetup } from '../../setup/vector-db-setup/weaviate-vector-db-setup';
import { checkOutBranch, getChangedFiles, getGitDiffHunks } from '../../setup/git-setup/git-setup';
import { DiffDetails } from '../../setup/git-setup/git-setup';
import { getCodingGuidelines, getTaskDetails } from '../../setup/clickup-setup/clickup-setup';
import { AstGraphDbSetup } from '../../setup/graph-db-setup/neo4j-graph-with-ast-setup';
import { ModelJobsOutput, ModelReviewCheckerOutput, ModelReviewsOutput, ModelSecurityScanOutput } from '../../lib/ai-utils';
import { SecurityScannerAgent } from '../security-scanner-agent/security-scanner-agent';
import { ReviewCheckerAgent } from '../review-checker-agent/review-checker-agent';

export interface CreateOrchestratorModelsOptions {
  embeddingOpts: CreateEmbeddingModelOptions;
  plannerOpts: CreateModelOptions;
  reviewerOpts: CreateModelOptions;
  securityScannerOpts: CreateModelOptions;
  reviewCheck?: boolean;
  runInParallel?: boolean;
  additionalSecurityScan?: boolean;
  recursionLimit?: number;
}

interface SetupContext {
  currentBranch: string;
  taskDetails: {
    customId: string;
    name: string;
    textContent: string;
  };
  codingGuidelines: string;
}

export class OrchestratorAgent {
  private readonly plannerOpts: CreateModelOptions;
  private readonly reviewerOpts: CreateModelOptions;
  private readonly securityScannerOpts: CreateModelOptions;
  private readonly embeddingOpts: CreateEmbeddingModelOptions;
  private readonly reviewCheck: boolean;
  private readonly runInParallel: boolean;
  private readonly additionalSecurityScan: boolean;
  private readonly recursionLimit: number;
  private readonly graphDbSetup: AstGraphDbSetup;
  private readonly vectorDbSetup: WeaviateVectorDbSetup;

  constructor(opts: CreateOrchestratorModelsOptions) {
    this.plannerOpts = opts.plannerOpts;
    this.reviewerOpts = opts.reviewerOpts;
    this.securityScannerOpts = opts.securityScannerOpts;
    this.embeddingOpts = opts.embeddingOpts;
    this.reviewCheck = opts.reviewCheck ?? false;
    this.runInParallel = opts.runInParallel ?? false;
    this.additionalSecurityScan = opts.additionalSecurityScan ?? false;
    this.recursionLimit = opts.recursionLimit ?? 25;

    this.graphDbSetup = new AstGraphDbSetup(opts.embeddingOpts);
    this.vectorDbSetup = new WeaviateVectorDbSetup(opts.embeddingOpts);
  }

  public async getAgent() {
    const agentAnnotation = Annotation.Root({
      setupContext: Annotation<SetupContext>({
        reducer: (_x, y) => y,
      }),
      changedFiles: Annotation<string[]>({
        default: () => [],
        reducer: (_x, y) => y,
      }),
      modelSecurityScanOutput: Annotation<ModelSecurityScanOutput[]>({
        default: () => [],
        reducer: (x, y) => [...x, ...y],
      }),
      modelJobsOutput: Annotation<ModelJobsOutput[]>({
        default: () => [],
        reducer: (x, y) => [...x, ...y],
      }),
      modelReviewOutput: Annotation<ModelReviewsOutput[]>({
        default: () => [],
        reducer: (x, y) => [...x, ...y],
      }),
      changedFilesIndex: Annotation<number>({
        default: () => 0,
        reducer: (x, y) => x + y,
      }),
      changedFilesIndexSecurityScan: Annotation<number>({
        default: () => 0,
        reducer: (x, y) => x + y,
      }),
      jobIndex: Annotation<number>({
        default: () => 0,
        reducer: (x, y) => x + y,
      }),
    });

    const callSetup = async (_state: typeof agentAnnotation.State) => {
      const branch = process.env.REPO_BRANCH || '';
      const baseBranch = process.env.PR_BASE_BRANCH || '';
      await checkOutBranch(branch);

      const changedFiles = await getChangedFiles(baseBranch);
      const taskDetails = await getTaskDetails(branch);
      const relevantTaskDetails = {
        customId: taskDetails.custom_id,
        name: taskDetails.name,
        textContent: taskDetails.text_content,
      };
      const codingGuidelines = await getCodingGuidelines();

      const gitDiffHunks: DiffDetails[] = [];
      for (const filePath of changedFiles) {
        const fileDiffHunks = await getGitDiffHunks(filePath, baseBranch);
        gitDiffHunks.push(fileDiffHunks);
      }

      await this.graphDbSetup.buildGraph(gitDiffHunks);

      return { 
        setupContext: {
          taskDetails: relevantTaskDetails || '',
          codingGuidelines: codingGuidelines?.content || '',
        },
        changedFiles: changedFiles || [],
      };
    };

    const callSequentialSecurityScannerAgent = async (state: typeof agentAnnotation.State) => {
      if (state.changedFilesIndexSecurityScan >= state.changedFiles.length) {
        return {
          modelSecurityScanOutput: [],
        };
      }
      const securityAgent = new SecurityScannerAgent(this.securityScannerOpts);
      const agent = await securityAgent.getAgent();
      const changedFilesIndexSecurityScan = state.changedFilesIndexSecurityScan;
      const changedFile = state.changedFiles[changedFilesIndexSecurityScan];

      const response = await agent.invoke({
        messages: [
          new HumanMessage(
            `## Changed File:\n${changedFile}\n`
          )
        ]
      },
      { recursionLimit: this.recursionLimit, });

      const modelSecurityScanOutput = response.modelOutput as ModelSecurityScanOutput[];

      return {
        modelSecurityScanOutput,
        changedFilesIndexSecurityScan: 1,
      };
    };

    const callParallelSecurityScannerAgents = async (state: typeof agentAnnotation.State) => {
      const changedFiles = state.changedFiles;

      const results = await Promise.all(
        changedFiles.map(async (changedFile) => {
          const securityAgent: SecurityScannerAgent = new SecurityScannerAgent(this.securityScannerOpts);
          const agent = await securityAgent.getAgent();

          return agent.invoke({
            messages: [
              new HumanMessage(
                `## Changed File:\n${changedFile}\n`
              )
            ]
          },
          { recursionLimit: this.recursionLimit, });
        })
      );

      return {
        modelSecurityScanOutput: results.flatMap(result => result.modelOutput as ModelSecurityScanOutput[]),
      };
    };

    const callSequentialPlannerAgent = async (state: typeof agentAnnotation.State) => {
      if (state.changedFilesIndex >= state.changedFiles.length) {
        return {
          modelJobsOutput: [],
        };
      }

      const plannerAgent = new PlannerAgent(this.plannerOpts);
      const agent = await plannerAgent.getAgent();
      const changedFilesIndex = state.changedFilesIndex;
      const changedFile = state.changedFiles[changedFilesIndex];

      let securityFindings: ModelSecurityScanOutput[] = [];
      if (state.modelSecurityScanOutput.length > 0) {
        securityFindings = state.modelSecurityScanOutput.filter(
          output => output.involvedFile === changedFile
        );
      }

      const response = await agent.invoke({
        messages: [
          new HumanMessage(
            `## Changed File:\n${changedFile}\n` +
            `## Setup Context\n` +
            `${JSON.stringify(state.setupContext, null, 2)}\n` +
            `## Security Findings\n` +
            `${JSON.stringify(securityFindings, null, 2)}\n`
          )
        ]
      },
      { recursionLimit: this.recursionLimit, });

      const modelJobsOutput = response.modelOutput as ModelJobsOutput[];

      return {
        modelJobsOutput,
        changedFilesIndex: 1,
      };
    };

    const callParallelPlanningAgents = async (state: typeof agentAnnotation.State) => {
      const changedFiles = state.changedFiles;

      const results = await Promise.all(
        changedFiles.map(async (changedFile) => {
          const plannerAgent: PlannerAgent = new PlannerAgent(this.plannerOpts);
          const agent = await plannerAgent.getAgent();

          let securityFindings = '';
          if (state.modelSecurityScanOutput.length > 0) {
            securityFindings = state.modelSecurityScanOutput
              .find(output => output.involvedFile === changedFile)?.results || '';
          }

          return agent.invoke({
            messages: [
              new HumanMessage(
                `## Changed File:\n${changedFile}\n\n` +
                `## Setup Context\n` +
                `${JSON.stringify(state.setupContext, null, 2)}\n` +
                `## Security Findings\n` +
                `${JSON.stringify(securityFindings, null, 2)}\n`
              )
            ]
          },
          { recursionLimit: this.recursionLimit, });
        })
      );

      const modelJobsOutput = results.flatMap(result => result.modelOutput as ModelJobsOutput[]);

      return {
        modelJobsOutput,
      };
    };

    const callSequentialReviewerAgent = async (state: typeof agentAnnotation.State) => {
      const reviewerAgent = new ReviewAgent(this.reviewerOpts, this.embeddingOpts);
      const agent = await reviewerAgent.getAgent();
      const job = state.modelJobsOutput[state.jobIndex];

      const response = await agent.invoke({
        messages: [
          new HumanMessage(
            `## Review Job\n${JSON.stringify(job, null, 2)}\n\n` +
            `## Setup Context\n` +
            `${JSON.stringify(state.setupContext, null, 2)}\n`
          )
        ]
      },
      { recursionLimit: this.recursionLimit });

      return {
        modelReviewOutput: response.modelOutput,
        jobIndex: 1,
      };
    };

    const callParallelReviewerAgents = async (state: typeof agentAnnotation.State) => {
      const jobs = state.modelJobsOutput;

      const results = await Promise.all(
        jobs.map(async (job) => {
          const reviewerAgent = new ReviewAgent(this.reviewerOpts, this.embeddingOpts);
          const reviewChecker = new ReviewCheckerAgent(this.reviewerOpts);
          const reviewAgent = await reviewerAgent.getAgent();
          const reviewCheckerAgent = await reviewChecker.getAgent();
          const reviewHumanMessage = new HumanMessage(
            `## Review Job\n${JSON.stringify(job, null, 2)}\n\n` +
            `## Setup Context\n` +
            `${JSON.stringify(state.setupContext, null, 2)}\n\n`
          );

          let reviewResult = await reviewAgent.invoke({
            messages: [
              reviewHumanMessage,
              new HumanMessage(
                `## Review Check Feedback\n` +
                `No feedback yet.`
              )
            ],
          },
          {
            recursionLimit: this.recursionLimit,
          });

          if (this.reviewCheck) {
            const reviewCheckerResult = await reviewCheckerAgent.invoke({
              messages: [
                new HumanMessage(
                  `${JSON.stringify(reviewResult.messages, null, 2)}`
                )
              ],
            });

            const checkerOutput = reviewCheckerResult.modelOutput as ModelReviewCheckerOutput[];
            const isAcceptable = checkerOutput[0].isAcceptable;
            
            if (isAcceptable) {
              return reviewResult;
            }

            reviewResult = await reviewAgent.invoke({
              messages: [
                reviewHumanMessage,
                new HumanMessage(
                  `## Review Check Feedback\n` +
                  `${JSON.stringify(checkerOutput, null, 2)}\n`
                ),
              ],
            },
            {
              recursionLimit: this.recursionLimit,
            });
          }

          return reviewResult;
        })
      );

      return {
        modelReviewOutput: results.flatMap(result => result.modelOutput as ModelReviewsOutput[]),
      };
    };

    const orchestratorGraph = new StateGraph(agentAnnotation)
      .addNode('setup', callSetup);

    if (this.runInParallel) {
      orchestratorGraph
        .addNode('parallelPlanner', callParallelPlanningAgents)
        .addNode('parallelReviewer', callParallelReviewerAgents)
        .addNode('parallelSecurityScanner', callParallelSecurityScannerAgents)
        .addEdge(START, 'setup')
        .addConditionalEdges(
          'setup',
          (_state: typeof agentAnnotation.State) => {
            if (this.additionalSecurityScan) {
              return 'parallelSecurityScanner';
            }
            return 'parallelPlanner';
          }
        )
        .addEdge('parallelSecurityScanner', 'parallelPlanner')
        .addEdge('parallelPlanner', 'parallelReviewer')
        .addEdge('parallelReviewer', END);
    } else {
      orchestratorGraph
        .addNode('planner', callSequentialPlannerAgent)
        .addNode('reviewer', callSequentialReviewerAgent)
        .addNode('securityScanner', callSequentialSecurityScannerAgent)
        .addEdge(START, 'setup')
        .addEdge('setup', 'securityScanner')
        .addConditionalEdges(
          'securityScanner',
          (state: typeof agentAnnotation.State) =>
            (state.changedFilesIndexSecurityScan < state.changedFiles.length) 
            && this.additionalSecurityScan ? 'securityScanner' : 'planner',
          ['securityScanner', 'planner']
        )
        .addConditionalEdges(
          'planner',
          (state: typeof agentAnnotation.State) =>
            state.changedFilesIndex < state.changedFiles.length ? 'planner' : 'reviewer',
          ['planner', 'reviewer']
        )
        .addConditionalEdges(
          'reviewer',
          (state: typeof agentAnnotation.State) =>
            state.jobIndex < state.modelJobsOutput.length ? 'reviewer' : END,
          ['reviewer', END]
        );
    }

    const orchestratorAgent = orchestratorGraph.compile();

    return orchestratorAgent;
  }
}
