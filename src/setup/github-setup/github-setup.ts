import { logger, ModelReviewsOutput } from '../../lib/ai-utils';
import { getAllDiffHunks } from '../graph-db-setup/neo4j-graph-github-query';
import { MCPTools } from '../../lib/ai-tools/mcp-tools/mcp-tools';

interface CommentBody {
  body: string;
  commit_id: string;
  path: string;
  start_line?: number;
  line: number;
  start_side?: string;
}


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

    if (!reviewWriteTool || !addCommentTool) {
      logger.error('Required GitHub MCP tools not found');
      return;
    }

    await reviewWriteTool.invoke({
      method: 'create',
      owner,
      repo,
      pullNumber: prNumber,
    });

    for (const comment of preparedComments) {
      if (!comment) {
        continue;
      }

      try {
        const commentArgs: any = {
          owner,
          repo,
          pullNumber: prNumber,
          path: comment.path,
          body: comment.body,
          subjectType: 'LINE',
          line: comment.end_line,
          side: 'RIGHT',
        };

        if (comment.start_line && comment.end_line && comment.start_line !== comment.end_line) {
          commentArgs.startLine = comment.start_line;
          commentArgs.startSide = 'RIGHT';
        }

        await addCommentTool.invoke(commentArgs);
      } catch (error) {
        logger.error(
          { 
            err: error, 
            path: comment.path, 
            line: comment.end_line,
          }, 
          'Error adding comment to pending review'
        );
      }
    }

    await reviewWriteTool.invoke({
      method: 'submit_pending',
      owner,
      repo,
      pullNumber: prNumber,
      body: `Automated code review completed. ${preparedComments.length} issue(s) found.`,
      event: 'COMMENT'
    });
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
          start_line: hunk.start_line,
          end_line: hunk.end_line,
        };
      }

      return null;
    }).filter(Boolean);

    return matchingReviews;
  });

  return githubComments;
}