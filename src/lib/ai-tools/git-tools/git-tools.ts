import { simpleGit } from 'simple-git';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export function getFileContent() {
  const schema = z.object({
    path: z.string().describe('File path'),
    useBaseBranch: z.boolean().default(false).describe('use base branch instead of HEAD'),
  });

  return tool(
    async (input) => {
      const { path, useBaseBranch } = schema.parse(input);
      const git = simpleGit(process.env.REPO_PATH || '');
      const baseBranch = process.env.PR_BASE_BRANCH || '';
      const prHeadSha = process.env.PR_HEAD_SHA || '';

      const gitRef = useBaseBranch ? baseBranch : prHeadSha;

      try {
        const content = await git.show([`${gitRef}:${path}`]);
        return JSON.stringify({ path, exists: true, content }, null, 2);
      } catch {
        return JSON.stringify({ path, exists: false, content: '' }, null, 2);
      }
    },
    {
      name: 'get_file_content',
      description: 'Get full content of a file at a specific git ref (HEAD or base branch). Provide the file path and optionally whether to use the base branch.',
      schema,
    }
  );
}
