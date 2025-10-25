import { IndentationText, Project } from 'ts-morph';
import { logger, ModelReviewsOutput } from '../../lib/ai-utils';
import { getAllDiffHunks } from '../graph-db-setup/neo4j-graph-github-query';
import { Octokit } from 'octokit';

export async function postPullRequestReviewComments(reviews: ModelReviewsOutput[]) {
  const repoName = process.env.REPO_NAME || '';
  const prNumber = parseInt(process.env.PR_NUMBER || '0', 10) || 0;
  const [owner, repo] = repoName.split('/');
  
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
  });
  
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  
  const currentHeadSha = pr.head.sha;
  logger.info(`Using current PR head SHA: ${currentHeadSha}`);
  
  const preparedComments = await prepareGitHubComments(reviews);
  
  if (preparedComments.length === 0) {
    logger.info('No comments to post');
    return;
  }
  
  logger.info(`Preparing to post ${preparedComments.length} comments`);
  
  // Format comments with proper single/multi-line handling
  const reviewComments = preparedComments.map((comment: any) => {
    const reviewComment: any = {
      path: comment.path,
      body: comment.body,
      side: 'RIGHT',
    };
    
    // Critical: GitHub requires different parameters for single vs multi-line
    if (comment.startLine === comment.endLine) {
      // Single-line comment - ONLY use 'line'
      reviewComment.line = comment.endLine;
    } else {
      // Multi-line comment - use both 'start_line' and 'line'
      reviewComment.start_line = comment.startLine;
      reviewComment.start_side = 'RIGHT';
      reviewComment.line = comment.endLine;
    }
    
    return reviewComment;
  });
  
  try {
    const review = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: currentHeadSha,
      event: 'COMMENT',
      comments: reviewComments,
    });
    
    logger.info(`Successfully created review with ${reviewComments.length} comments`);
    logger.info(`Review ID: ${review.data.id}`);
  } catch (error: any) {
    logger.error('Failed to create review:', error.message);
    
    if (error.response?.data) {
      logger.error({ error: error.response.data }, 'GitHub API response:');
    }
    
    // Try posting comments individually as fallback
    logger.info('Falling back to individual comments...');
    
    for (const comment of preparedComments) {
      try {
        const params: any = {
          owner,
          repo,
          pull_number: prNumber,
          body: comment.body,
          commit_id: currentHeadSha,
          path: comment.path,
          side: 'RIGHT',
        };
        
        if (comment.startLine === comment.endLine) {
          params.line = comment.endLine;
        } else {
          params.start_line = comment.startLine;
          params.start_side = 'RIGHT';
          params.line = comment.endLine;
        }
        
        await octokit.rest.pulls.createReviewComment(params);
        logger.info(`✓ Posted comment on ${comment.path}:${comment.startLine}-${comment.endLine}`);
      } catch (commentError: any) {
        logger.error(`✗ Failed to post comment on ${comment.path}:${comment.startLine}-${comment.endLine}`, commentError.message);
        
        // Last resort: post as general PR comment
        try {
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: `**Comment on \`${comment.path}\` (lines ${comment.startLine}-${comment.endLine}):**\n\n${comment.body}`,
          });
          logger.info(`Posted as general comment instead`);
        } catch (issueError) {
          logger.error({ issueError }, `Failed to post as general comment:`);
        }
      }
    }
  }
}

async function prepareGitHubComments(reviews: ModelReviewsOutput[]) {
  const diffHunks = await getAllDiffHunks();
  
  const githubComments = diffHunks.flatMap(hunk => {
    // Filter FIRST, then map - more efficient
    const matchingReviews = reviews
      .filter(review => review.diffId === hunk.id && review.suggestion !== '')
      .map(review => {
        const formatted = formatCode(review.codeSuggestion);
        const codeBlock = `\`\`\`typescript\n${formatted}\n\`\`\``;
        const body = `${review.suggestion}\n\n**${review.type}**\n\nHere's a suggested fix:\n\n${codeBlock}`;
        
        return {
          body,
          diffType: hunk.diffType,
          commitId: hunk.commitId,
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

export function formatCode(code: string) {
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
    return code; // Return unformatted code on error
  }
}