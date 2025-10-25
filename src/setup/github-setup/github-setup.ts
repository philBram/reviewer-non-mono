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

  const prFiles = await octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const patchByPath = new Map<string, string>();
  for (const file of prFiles) {
    if (file.filename && file.patch) {
      patchByPath.set(file.filename, file.patch);
    }
  }

  const headCommitSha = process.env.PR_HEAD_SHA || '';

  for (const comment of preparedComments) {
    if (!comment) {
      continue;
    }

    logger.info(`Posting comment to PR #${prNumber} in ${owner}/${repo} on ${comment.path}:${comment.startLine}-${comment.endLine}`);

    const patch = patchByPath.get(comment.path);

    if (!patch) {
      logger.warn({ path: comment.path }, 'No patch available for file; skipping comment.');
      continue;
    }

    const targetLine = comment.endLine ?? comment.startLine;
    const position = targetLine ? computeDiffPosition(patch, targetLine) : null;

    if (!position) {
      logger.warn({ path: comment.path, targetLine }, 'Could not resolve diff position for comment; skipping.');
      continue;
    }

    await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
      owner,
      repo,
      pull_number: prNumber,
      body: comment.body,
      commit_id: comment.commitId || headCommitSha,
      path: comment.path,
      position,
      headers: {
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
  }
}

function computeDiffPosition(patch: string, targetLine: number): number | null {
  const lines = patch.split('\n');
  let position = 0;
  let currentNewLine = 0;

  for (const line of lines) {
    position += 1;

    if (line.startsWith('@@')) {
      const match = /\+([0-9]+)(?:,([0-9]+))?/.exec(line);
      if (match) {
        currentNewLine = parseInt(match[1], 10) - 1;
      }
      continue;
    }

    const indicator = line.charAt(0);

    if (indicator === ' ' || indicator === '+') {
      currentNewLine += 1;

      if (currentNewLine === targetLine) {
        return position;
      }
    }
  }

  return null;
}

async function prepareGitHubComments(reviews: ModelReviewsOutput[]) {
  const diffHunks = await getAllDiffHunks();

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

      if (review.diffId === hunk.id && review.suggestion !== '') {
        return {
          body: body,
          diffType: hunk.diffType,
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