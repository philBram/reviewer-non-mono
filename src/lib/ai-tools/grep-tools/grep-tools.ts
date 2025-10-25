import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getIgnoreRegex } from '../../ai-utils';

const execFileAsync = promisify(execFile);

export interface GrepMatch {
  file: string;
  context: string[];
}

export async function grepSearch(pattern: string, contextLines: number, useRegex: boolean = true, filePath?: string) {
  const DEFAULT_IGNORE_REGEX = getIgnoreRegex();
  const repoPath = process.env.REPO_PATH || '';

  const grepArgs = [
    '-R',
    '-n',
    '-H',
    '-I',
    '--color=never',
    '--binary-files=without-match',
    '-s',
    '--include=*.ts',
    '-C', String(contextLines),
  ];

  if (useRegex) {
    grepArgs.push('-E');
  }

  const searchPath = filePath ? path.join(repoPath, filePath) : repoPath;
  grepArgs.push('--', pattern, searchPath);

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

  const filtered = results.filter(result => !DEFAULT_IGNORE_REGEX.test(result.file));

  return filtered;
}

export function searchCode() {
  const schema = z.object({
    pattern: z.string().describe('Search pattern (supports regex and plain text)'),
    filePath: z.string().optional().describe('File path to limit the search to a specific file'),
    contextLines: z.number().default(10).describe('Number of context lines around each match (default 10)'),
    useRegex: z.boolean().default(true).describe('Treat pattern as extended regex (default true)'),
    maxResults: z.number().default(10).describe('Maximum number of file results to return (default 10)'),
  });

  return tool(
    async (input) => {
      const { pattern, contextLines, useRegex, maxResults, filePath } = schema.parse(input);

      try {
        const matches = await grepSearch(pattern, contextLines, useRegex, filePath);
        
        if (matches.length === 0) {
          return JSON.stringify({ found: false, matches: [], message: 'No matches found.' }, null, 2);
        }

        const truncatedMatches = matches.slice(0, maxResults);
        const results = truncatedMatches.map(match => ({
          file: match.file,
          context: match.context.join('\n'),
        }));
        const truncated = matches.length > maxResults;

        return JSON.stringify({ 
          found: true,
          count: results.length,
          truncated, 
          total: matches.length,
          matches: results 
        }, null, 2);
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
