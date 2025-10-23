import { execFile } from 'child_process';
import { promisify } from 'util';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import path from 'path';

const execFileAsync = promisify(execFile);

export interface GrepMatch {
  file: string;
  context: string[];
}

export async function grepSearch(pattern: string, contextLines: number, useRegex: boolean = true) {
  const repoPath = process.env.REPO_PATH || '';

  const grepArgs = [
    '-R',
    '-n',
    '-H',
    '-I',
    '--color=never',
    '--binary-files=without-match',
    '-s',
    '-C', String(contextLines),
  ];

  if (useRegex) {
    grepArgs.push('-E');
  }

  grepArgs.push('--', pattern, repoPath);

  const { stdout } = await execFileAsync('grep', grepArgs, { maxBuffer: 10 * 1024 * 1024 });

  if (!stdout) {
    return [] as GrepMatch[];
  }

  const results: GrepMatch[] = [];
  let currentResult: GrepMatch | null = null;
  let lastFile = '';

  for (const line of stdout.split('\n').filter(Boolean)) {
    const tsIndex = line.indexOf('.ts');

    if (tsIndex === -1) {
      continue;
    }

    const file = line.substring(0, tsIndex + 3);
    const rest = line.substring(tsIndex + 4);
    const contentMatch = rest.match(/^\d+[:-](.*)$/);
    const content = contentMatch ? contentMatch[1] : '';

    if (file !== lastFile) {
      if (currentResult) {
        results.push(currentResult);
      }
      currentResult = {
        file: file,
        context: [],
      }
    }

    if (currentResult) {
      currentResult.context.push(content);
    }

    lastFile = file;
  }

  if (currentResult) {
    results.push(currentResult);
  }

  return results;
}

export function searchCode() {
  const schema = z.object({
    pattern: z.string().describe('Search pattern (supports regex and plain text)'),
    contextLines: z.number().default(10).describe('Number of context lines around each match (default 10)'),
    useRegex: z.boolean().default(true).describe('Treat pattern as extended regex (default true)'),
  });

  return tool(
    async (input) => {
      const { pattern, contextLines, useRegex } = schema.parse(input);
      
      try {
        const matches = await grepSearch(pattern, contextLines, useRegex);
        
        if (matches.length === 0) {
          return JSON.stringify({ found: false, matches: [], message: 'No matches found.' }, null, 2);
        }

        const results = matches.map(match => ({
          file: match.file,
          context: match.context.join('\n'),
        }));

        return JSON.stringify({ found: true, count: results.length, matches: results }, null, 2);
      } catch (error: any) {
        return JSON.stringify({ 
          found: false, 
          matches: [], 
          error: error?.message || 'Grep search failed' 
        }, null, 2);
      }
    },
    {
      name: 'search_code',
      description: 'Recursively search the codebase for a pattern (class names, function names, keywords, etc.) and return matches with surrounding context lines. Use regex for flexible matching.',
      schema,
    }
  );
}