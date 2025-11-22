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
}

async function getSimpleGitClient() {
  return simpleGit(process.env.REPO_PATH || '');
}

export async function gitCheckout(usePRBranch: boolean = true) {
  const git = await getSimpleGitClient();
  const baseBranch = process.env.PR_BASE_BRANCH || '';
  const prHeadSha = process.env.PR_HEAD_SHA || '';
  const checkoutRef = usePRBranch ? prHeadSha : baseBranch;

  await git.checkout(checkoutRef);
}

export async function getChangedFiles() {
  const git = await getSimpleGitClient();
  const prHeadSha = process.env.PR_HEAD_SHA || '';
  const baseBranch = process.env.PR_BASE_BRANCH || '';
  const raw = await git.diff(['--name-only', '--diff-filter=AM', `${baseBranch}...${prHeadSha}`]);
  const files = raw.trim().split('\n').filter(Boolean);
  const filteredFiles = files.filter(file => !getIgnoreRegex().test(file));

  return filteredFiles;
}

export async function getGitDiffHunks(filePath: string) {
  if (getIgnoreRegex().test(filePath)) {
    return {
      filePath,
      hunks: [],
    };
  }

  const git = await getSimpleGitClient();
  const prHeadSha = process.env.PR_HEAD_SHA || '';
  const baseBranch = process.env.PR_BASE_BRANCH || '';
  const diff = await git.diff([
    `${baseBranch}...${prHeadSha}`,
    '--no-color',
    '--',
    filePath,
  ]);

  const diffHunks: DiffHunks[] = [];
  let currentHunk: DiffHunks | null = null;

  for (const line of diff.split('\n')) {
    const hunkHeader = line.match(/^@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
    
    if (hunkHeader) {
      if (currentHunk) {
        await addDiffHunk(currentHunk, diffHunks);
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
    await addDiffHunk(currentHunk, diffHunks);
  }

  const diffDetails: DiffDetails = {
    filePath,
    hunks: diffHunks,
  };

  return diffDetails;
};

async function addDiffHunk(currentHunk: DiffHunks, diffHunks: DiffHunks[]) {
  const oldStart = currentHunk.oldStart;
  const startLine = currentHunk.startLine;
  const endLine = currentHunk.endLine;

  if (oldStart > 0) {
    currentHunk.diffType = 'MODIFIED';
  } else {
    currentHunk.diffType = 'ADDED';
  }

  diffHunks.push({
    startLine: startLine,
    endLine: endLine,
    oldStart,
    diffType: currentHunk.diffType,
    content: currentHunk.content,
  });
}