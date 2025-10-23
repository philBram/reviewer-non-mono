import simpleGit from 'simple-git';

const IGNORE_REGEX = /node_modules|\/dist\/|\/build\/|\.spec\.ts$|\.d\.ts$|jest.*\.ts$|\.ya?ml$|\.json$/;

export interface DiffDetails {
  file_path?: string;
  commit_id?: string;
  hunks: DiffHunks[];
}

interface DiffHunks {
  start_line: number;
  end_line?: number;
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
  const git = await getSimpleGitClient();
  const commitSha = await git.revparse(['HEAD']);

  const diff = await git.diff([
    `${baseBranch}...HEAD`,
    '--no-color',
    '--',
    file_path,
  ]);

  const diffHunks: DiffHunks[] = [];
  let currentHunk: DiffHunks | null = null;

  for (const line of diff.split('\n')) {
    const hunkHeader = line.match(/^@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
    
    if (hunkHeader) {
      if (currentHunk) {
        diffHunks.push({
          start_line: currentHunk.start_line,
          end_line: currentHunk.start_line + currentHunk.content.length - 1,
          content: currentHunk.content,
          commit_id: commitSha,
        });
      }
      currentHunk = {
        start_line: parseInt(hunkHeader[3], 10),
        content: [],
      };
      continue;
    }
    if (currentHunk) {
      currentHunk.content.push(line);
    }
  }

  if (currentHunk) {
    currentHunk.end_line = currentHunk.start_line + currentHunk.content.length - 1;
    currentHunk.commit_id = commitSha;
    diffHunks.push(currentHunk);
  }

  const diffDetails: DiffDetails = {
    file_path,
    commit_id: commitSha,
    hunks: diffHunks,
  };

  return diffDetails;
};