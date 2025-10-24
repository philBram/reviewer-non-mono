import { IndentationText, Project } from 'ts-morph';
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
      start_line: comment.start_line,
      start_side: 'RIGHT',
      line: comment.end_line,
      side: 'RIGHT',
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
      const formatted = formatCode(review.code_suggestion);
      const codeBlock = 
      `\`\`\`typescript
      ${formatted}
      \`\`\``;
      const body = 
        review.suggestion + '\n\n' + review.type + '\n\n' + 
        "Here's a suggested fix:" + '\n\n' + codeBlock;

      if (review.diff_id === hunk.id && review.suggestion != '') {
        return {
          body: body,
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

export function formatCode(code: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    manipulationSettings: { indentationText: IndentationText.TwoSpaces },
  });

  const sf = project.createSourceFile('tmp.ts', code, { overwrite: true });
  sf.formatText();
  const formatted = sf.getFullText();
  project.removeSourceFile(sf);

  return formatted;
}