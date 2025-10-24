import { parse } from 'path';
import simpleGit from 'simple-git';
import { ar } from 'zod/v4/locales';

const IGNORE_REGEX = /node_modules|\/dist\/|\/build\/|\.spec\.ts$|\.d\.ts$|jest.*\.ts$|\.ya?ml$|\.json$|\.md$/;

export interface DiffDetails {
  filePath?: string;
  hunks: DiffHunks[];
}

interface DiffHunks {
  startLine: number;
  endLine: number;
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
  const filteredFiles = files.filter(file => !IGNORE_REGEX.test(file));

  return filteredFiles;
}

export async function getGitDiffHunks(filePath: string, baseBranch: string) {
  if (IGNORE_REGEX.test(filePath)) {
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
        const endLine = currentHunk.endLine;
        const commit = await git.log([`-L ${currentHunk.startLine},${endLine}:${filePath}`]);
        const commitId = commit?.latest?.hash;
        const oldStart = parseInt(hunkHeader[1], 10);
        const oldCount = parseInt(hunkHeader[2] || '1', 10);
        const newStart = parseInt(hunkHeader[3], 10);
        const newCount = parseInt(hunkHeader[4] || '1', 10);

        if (oldStart === 0 && oldCount === 0) {
          currentHunk.diffType = 'ADDED';
        } else {
          currentHunk.diffType = 'MODIFIED';
        }

        diffHunks.push({
          startLine: newStart,
          endLine: newCount,
          diffType: currentHunk.diffType,
          content: currentHunk.content,
          commitId: commitId,
        });
      }
      currentHunk = {
        startLine: 0,
        endLine: 0,
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
    const endLine = currentHunk.endLine;
    const commit = await git.log([`-L ${currentHunk.startLine},${endLine}:${filePath}`]);

    currentHunk.commitId = commit?.latest?.hash;
    diffHunks.push(currentHunk);
  }

  const diffDetails: DiffDetails = {
    filePath,
    hunks: diffHunks,
  };

  return diffDetails;
};
