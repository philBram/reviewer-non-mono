import { simpleGit } from 'simple-git';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export function getFileContent() {
  const schema = z.object({
    path: z.string().describe('File path'),
    ref: z.enum(['HEAD', 'dev']).default('HEAD').describe('Ref / branch (default HEAD, can be dev)'),
  });

  return tool(
    async (input) => {
      const { path, ref } = schema.parse(input);
      const git = simpleGit(process.env.REPO_PATH || '');

      try {
        const content = await git.show([`${ref}:${path}`]);
        return JSON.stringify({ ref, path, exists: true, content }, null, 2);
      } catch {
        return JSON.stringify({ ref, path, exists: false, content: '' }, null, 2);
      }
    },
    {
      name: 'get_file_content',
      description: 'Get full file content at a given ref (HEAD by default).',
      schema,
    }
  );
}
