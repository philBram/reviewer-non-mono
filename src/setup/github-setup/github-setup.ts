import { logger, ModelReviewsOutput } from '../../lib/ai-utils';
import { getAllDiffHunks } from '../graph-db-setup/neo4j-graph-github-query';
import { Octokit } from 'octokit';

export async function postPullRequestReviewComments(reviews: ModelReviewsOutput[]) {
  const repoName = process.env.REPO_NAME || '';
  const prNumber = parseInt(process.env.PR_NUMBER || '0', 10) || 0;

  const [owner, repo] = repoName.split('/');
  
  const preparedComments = await prepareGitHubComments(reviews);

  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
  })

  for (const comment of preparedComments) {
    if (!comment) {
      continue;
    }

    await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
      owner: owner,
      repo: repo,
      pull_number: prNumber,
      body: comment.body,
      commit_id: comment.commit_id,
      path: comment.path,
      subject_type: 'file',
      headers: {
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
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
        };
      }

      return null;
    }).filter(Boolean);

    return matchingReviews;
  });

  return githubComments;
}