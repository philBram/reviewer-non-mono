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
      commit_id: comment.commitId,
      path: comment.path,
      start_line: comment.startLine,
      start_side: 'RIGHT',
      line: comment.endLine,
      side: 'RIGHT',
      headers: {
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
  }
}

async function prepareGitHubComments(reviews: ModelReviewsOutput[]) {
  const diffHunks = await getAllDiffHunks();

  logger.debug({diffHunks});

  const githubComments = diffHunks.flatMap(hunk => {
    const matchingReviews = reviews.map(review => {
      const formatted = formatCode(review.codeSuggestion);
      const codeBlock = 
      `\`\`\`typescript
      ${formatted}
      \`\`\``;
      const body = 
        review.suggestion + '\n\n' + `**${review.type}**` + '\n\n' + 
        "Here's a suggested fix:" + '\n\n' + codeBlock;

      if (review.diffId === hunk.id && review.suggestion != '') {
        return {
          body: body,
          commitId: hunk.commitId,
          path: hunk.source,
          startLine: hunk.startLine,
          endLine: hunk.endLine,
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