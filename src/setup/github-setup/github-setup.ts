import { IndentationText, Project } from 'ts-morph';
import { logger, ModelReviewsOutput } from '../../lib/ai-utils';
import { getAllDiffHunks } from '../graph-db-setup/neo4j-graph-github-query';
import { Octokit } from 'octokit';

interface ReviewComment {
  path: string;
  body: string;
  side: string;
  start_line?: number;
  start_side?: string;
  line?: number;
}

export async function postPullRequestReviewComments(reviews: ModelReviewsOutput[]) {
  const repoName = process.env.REPO_NAME || '';
  const prNumber = parseInt(process.env.PR_NUMBER || '0', 10) || 0;
  const PR_HEAD_SHA = process.env.PR_HEAD_SHA || '';
  const [owner, repo] = repoName.split('/');
  
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
  });
  
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const reviewCommentCount = pr.review_comments;
  const currentHeadSha = pr.head.sha;

  if (currentHeadSha !== PR_HEAD_SHA || reviewCommentCount > 0) {
    logger.info(`Skipping: SHA mismatch (${currentHeadSha} vs ${PR_HEAD_SHA}) or comments exist (${reviewCommentCount} review comments)`);
    return;
  }
  
  const preparedComments = await prepareGitHubComments(reviews);
  
  if (preparedComments.length === 0) {
    return;
  }

  const reviewComments = preparedComments.map((comment) => {
    const reviewComment: ReviewComment = {
      path: comment.path,
      body: comment.body,
      side: 'RIGHT',
    };
    
    if (comment.startLine === comment.endLine) {
      reviewComment.line = comment.endLine;
    } else {
      reviewComment.start_line = comment.startLine;
      reviewComment.start_side = 'RIGHT';
      reviewComment.line = comment.endLine;
    }
    
    return reviewComment;
  });
  
  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: currentHeadSha,
      event: 'COMMENT',
      comments: reviewComments,
    });
    
    logger.info(`Successfully created review with ${reviewComments.length} comments`);
  } catch (error) {
    logger.error({ error }, 'Failed to post review comments to GitHub');
  }
}

async function prepareGitHubComments(reviews: ModelReviewsOutput[]) {
  const diffHunks = await getAllDiffHunks();
  
  const githubComments = diffHunks.flatMap(hunk => {
    const matchingReviews = reviews
      .filter(review => review.diffId === hunk.id && review.suggestion !== '')
      .map(review => {
        //const formatted = formatCode(review.codeSuggestion);
        const codeBlock = `\`\`\`typescript\n${review.codeSuggestion}\n\`\`\``;
        const body = `${review.suggestion}\n\n**${review.type}**\n\nHere's a suggested fix:\n\n${codeBlock}`;
        
        return {
          body,
          diffType: hunk.diffType,
          path: hunk.source,
          startLine: hunk.startLine,
          endLine: hunk.endLine,
        };
      });
    
    return matchingReviews;
  });
  
  logger.info(`Prepared ${githubComments.length} GitHub comments from ${diffHunks.length} diff hunks`);
  
  return githubComments;
}

/*function formatCode(code: string) {
  try {
    const project = new Project({
      useInMemoryFileSystem: true,
      manipulationSettings: { indentationText: IndentationText.TwoSpaces },
    });
    
    const sf = project.createSourceFile('tmp.ts', code, { overwrite: true });
    sf.formatText();
    const formatted = sf.getFullText();
    project.removeSourceFile(sf);
    
    return formatted;
  } catch (error) {
    logger.error({ error }, 'Failed to format code:');
    return code;
  }
}*/