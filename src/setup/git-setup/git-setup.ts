import { parse } from 'path';
import simpleGit from 'simple-git';
import { ar } from 'zod/v4/locales';

const IGNORE_REGEX = /node_modules|\/dist\/|\/build\/|\.spec\.ts$|\.d\.ts$|jest.*\.ts$|\.ya?ml$|\.json$|\.md$/;

export interface DiffDetails {
  file_path?: string;
  hunks: DiffHunks[];
}

interface DiffHunks {
  start_line: number;
  end_line: number;
  start_overlap: number;
  end_overlap: number;
  content: string[];
  commit_id?: string;
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

export async function getGitDiffHunks(file_path: string, baseBranch: string) {
  if (IGNORE_REGEX.test(file_path)) {
    return {
      file_path,
      hunks: [],
    };
  }

  const git = await getSimpleGitClient();
  const diff = await git.diff([
    `${baseBranch}...HEAD`,
    '--no-color',
    '--unified=0',
    '--',
    file_path,
  ]);

  const diffHunks: DiffHunks[] = [];
  let currentHunk: DiffHunks | null = null;

  for (const line of diff.split('\n')) {
    const hunkHeader = line.match(/^@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
    
    if (hunkHeader) {
      if (currentHunk) {
        const end_line = currentHunk.end_line;
        const commit = await git.log([`-L ${currentHunk.start_line},${end_line}:${file_path}`]);
        const commit_id = commit?.latest?.hash;

        diffHunks.push({
          start_line: currentHunk.start_line,
          end_line: end_line,
          start_overlap: currentHunk.start_overlap,
          end_overlap: currentHunk.end_overlap,
          content: currentHunk.content,
          commit_id: commit_id,
        });
      }
      currentHunk = {
        start_line: parseInt(hunkHeader[3], 10),
        end_line: parseInt(hunkHeader[3], 10) + (parseInt(hunkHeader[4], 10) || 1) - 1,
        start_overlap: parseInt(hunkHeader[1], 10),
        end_overlap: parseInt(hunkHeader[1], 10) + (parseInt(hunkHeader[2], 10) || 1) - 1,
        content: [],
      };
      continue;
    }
    if (currentHunk) {
      currentHunk.content.push(line);
    }
  }

  if (currentHunk) {
    const end_line = currentHunk.end_line;
    const commit = await git.log([`-L ${currentHunk.start_line},${end_line}:${file_path}`]);

    currentHunk.commit_id = commit?.latest?.hash;
    diffHunks.push(currentHunk);
  }

  const diffDetails: DiffDetails = {
    file_path,
    hunks: diffHunks,
  };

  return diffDetails;
};
