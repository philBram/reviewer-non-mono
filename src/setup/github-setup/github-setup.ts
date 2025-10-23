import { logger, ModelReviewsOutput } from '../../lib/ai-utils';
import { getAllDiffHunks } from '../graph-db-setup/neo4j-graph-github-query';
import { MCPTools } from '../../lib/ai-tools/mcp-tools/mcp-tools';

export async function postPullRequestReviewComments(reviews: ModelReviewsOutput[]) {
  const repoName = process.env.REPO_NAME || '';
  const prNumber = parseInt(process.env.PR_NUMBER || '0', 10) || 0;

  const [owner, repo] = repoName.split('/');
  
  const preparedComments = await prepareGitHubComments(reviews);

  if (preparedComments.length === 0) {
    logger.info('No comments to post');
    return;
  }

  try {
    const githubTools = await MCPTools.getGitHubPRTools();
    
    const reviewWriteTool = githubTools.find(t => t.name === 'pull_request_review_write');
    const addCommentTool = githubTools.find(t => t.name === 'add_comment_to_pending_review');

    const firstComment = preparedComments[0];
    const commitId = firstComment?.commit_id;

    if (!reviewWriteTool || !addCommentTool) {
      logger.error('Required GitHub MCP tools not found');
      return;
    }

    logger.info({ owner, repo, prNumber, commitId }, 'Creating pending review');
    const createResult = await reviewWriteTool.invoke({
      method: 'create',
      owner,
      repo,
      pullNumber: prNumber,
      commitID: commitId,
    });
    logger.info({ result: createResult }, 'Pending review created');

    for (const comment of preparedComments) {
      if (!comment) {
        continue;
      }

      const commentArgs = {
        owner,
        repo,
        pullNumber: prNumber,
        path: comment.path,
        body: comment.body,
        subjectType: 'LINE',
        line: comment.line,
        side: 'RIGHT',
      };

      logger.info({ commentArgs }, 'Attempting to add comment');
      
      try {
        const result = await addCommentTool.invoke(commentArgs);
        logger.info({ result, path: comment.path, line: comment.line }, 'Comment added successfully');
      } catch (error) {
        logger.error(
          { 
            error: error,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            commentArgs,
          }, 
          'Failed to add comment to pending review'
        );
      }
    }

    const submitResult = await reviewWriteTool.invoke({
      method: 'submit_pending',
      owner,
      repo,
      pullNumber: prNumber,
      body: `Automated code review completed. ${preparedComments.length} issue(s) found.`,
      event: 'COMMENT'
    });
    logger.info({ result: submitResult }, 'Review submitted successfully');
  } catch (error) {
    logger.error({ err: error }, 'Failed to post PR review comments via MCP');
  }
}


async function prepareGitHubComments(reviews: ModelReviewsOutput[]) {
  const diffHunks = await getAllDiffHunks();

  const githubComments = diffHunks.flatMap(hunk => {
    const matchingReviews = reviews.map(review => {
      if (review.diff_id === hunk.id) {
        return {
          body: review.suggestion + '\n\n' + review.code_suggestion,
          commit_id: hunk.commit_id,
          path: hunk.source,
          line: hunk.end_line,
        };
      }

      return null;
    }).filter(Boolean);

    return matchingReviews;
  });

  return githubComments;
}