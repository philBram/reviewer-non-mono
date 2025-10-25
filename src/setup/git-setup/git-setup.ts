import simpleGit, { SimpleGit } from 'simple-git';
import { getIgnoreRegex } from '../../lib/ai-utils';

export interface DiffDetails {
  filePath?: string;
  hunks: DiffHunks[];
}

interface DiffHunks {
  startLine: number;
  endLine: number;
  oldStart: number;
  diffType: string;
  content: string[];
  commitId?: string;
}

async function getSimpleGitClient() {
  return simpleGit(process.env.REPO_PATH || '');
}

export async function checkOutBranch(branchName: string) {
  const git = await getSimpleGitClient();
  await git.checkout(branchName);
}

export async function getChangedFiles(baseBranch: string) {
  const git = await getSimpleGitClient();
  const raw = await git.diff(['--name-only', '--diff-filter=AM', `${baseBranch}...HEAD`]);
  const files = raw.trim().split('\n').filter(Boolean);
  const filteredFiles = files.filter(file => !getIgnoreRegex().test(file));

  return filteredFiles;
}

export async function getGitDiffHunks(filePath: string, baseBranch: string) {
  if (getIgnoreRegex().test(filePath)) {
    return {
      filePath,
      hunks: [],
    };
  }

  const git = await getSimpleGitClient();
  const diff = await git.diff([
    `${baseBranch}...HEAD`,
    '--no-color',
    '--unified=0',
    '--',
    filePath,
  ]);

  const diffHunks: DiffHunks[] = [];
  let currentHunk: DiffHunks | null = null;

  for (const line of diff.split('\n')) {
    const hunkHeader = line.match(/^@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
    
    if (hunkHeader) {
      if (currentHunk) {
        await diffHunkHelper(currentHunk, git, filePath, diffHunks);
      }
      currentHunk = {
        startLine: parseInt(hunkHeader[3], 10),
        endLine: parseInt(hunkHeader[3], 10) + parseInt(hunkHeader[4] || '1', 10) - 1,
        oldStart: parseInt(hunkHeader[1], 10),
        diffType: '',
        content: [],
      };

      continue;
    }
    if (currentHunk) {
      currentHunk.content.push(line);
    }
  }

  if (currentHunk) {
    await diffHunkHelper(currentHunk, git, filePath, diffHunks);
  }

  const diffDetails: DiffDetails = {
    filePath,
    hunks: diffHunks,
  };

  return diffDetails;
};

async function diffHunkHelper(currentHunk: DiffHunks, git: SimpleGit, filePath: string, diffHunks: DiffHunks[]) {
  const oldStart = currentHunk.oldStart;
  const startLine = currentHunk.startLine;
  const endLine = currentHunk.endLine;
  let commitId: string | undefined;

  if (oldStart > 0) {
    currentHunk.diffType = 'MODIFIED';
    const commit = await git.log([`-L ${startLine},${endLine}:${filePath}`]);
    commitId = commit?.latest?.hash;
  } else {
    currentHunk.diffType = 'ADDED';
    const commit = await git.log(['--follow', '--', filePath]);
    commitId = commit?.latest?.hash;
  }

  diffHunks.push({
    startLine: startLine,
    endLine: endLine,
    oldStart,
    diffType: currentHunk.diffType,
    content: currentHunk.content,
    commitId: commitId,
  });
}