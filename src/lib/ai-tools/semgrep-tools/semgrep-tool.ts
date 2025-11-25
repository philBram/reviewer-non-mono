import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function getSemgrepScanTool() {
  const schema = z.object({
    path: z.string().describe('File or directory path to scan'),
    config: z.string().default('auto').describe('Semgrep ruleset (auto, p/security-audit, p/owasp-top-ten, etc.). Defaults to "auto".')
  });

  return tool(
    async (input) => {
      const { path, config } = schema.parse(input);

      try {
        const { stdout } = await execAsync(
          `semgrep scan --config=${config} --json "${path}"`,
          { 
            maxBuffer: 50 * 1024 * 1024,
            timeout: 300000
          }
        );
        
        const results = JSON.parse(stdout);

        return JSON.stringify({
          findings: results.results?.length || 0,
          results: results.results || []
        }, null, 2);
      } catch (_error) {
        return JSON.stringify({
          findings: 0,
          results: []
        });
      }
    },
    {
      name: 'semgrep_scan',
      description: 'Scans code for security vulnerabilities and bugs using Semgrep. Provide a file or directory path.',
      schema,
    }
  );
}