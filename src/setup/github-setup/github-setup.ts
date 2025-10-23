import { logger, ModelReviewsOutput } from '../../lib/ai-utils';
import { getAllDiffHunks } from '../graph-db-setup/neo4j-graph-github-query';

interface CommentBody {
  body: string;
  commit_id: string;
  path: string;
  start_line?: number;
  line: number;
  start_side?: string;
}


export async function postPullRequestReviewComments(reviews: ModelReviewsOutput[]) {
  const token = process.env.GITHUB_TOKEN || '';
  const repoName = process.env.REPO_NAME || '';
  const prNumber = parseInt(process.env.PR_NUMBER || '0', 10) || 0;

  const [owner, repo] = repoName.split('/');
  
  const preparedComments = await prepareGitHubComments(reviews);

  for (const comment of preparedComments) {
    try {
      logger.debug({ 
        path: comment?.path, 
        startLine: comment?.start_line, 
        endLine: comment?.end_line,
        commitId: comment?.commit_id 
      }, 'Posting comment to GitHub');
      
      const commentBody: any = {
        body: comment?.body,
        commit_id: comment?.commit_id,
        path: comment?.path,
        side: 'RIGHT',
      };

      if (comment?.start_line && comment?.end_line && comment?.start_line !== comment?.end_line) {
        commentBody.start_line = comment.start_line;
        commentBody.line = comment.end_line;
        commentBody.start_side = 'RIGHT';
      } else {
        commentBody.line = comment?.end_line || comment?.start_line;
      }

      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify(commentBody)
      });

      if (!response.ok) {
        const errorData = await response.text();
        logger.error(
          { 
            status: response.status, 
            statusText: response.statusText, 
            errorData, 
            path: comment?.path,
            owner,
            repo,
            prNumber
          }, 
          'GitHub API error when posting comment'
        );
        continue;
      }

      logger.info({ path: comment?.path, line: comment?.start_line }, 'Comment posted successfully');
    } catch (error) {
      logger.error(
        { 
          err: error, 
          path: comment?.path, 
          endLine: comment?.end_line,
          owner,
          repo,
          prNumber
        }, 
        'Failed to post comment'
      );
    }
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