import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { logger } from '../../ai-utils/logger';

export class MCPTools {
  private static _mcpclient: MultiServerMCPClient;

  private constructor() {}

  public static async getSemgrepTools() {
    if (!this._mcpclient) {
      this._mcpclient = this.initializeMCPClient();
    }
    const semgrepTools = await this._mcpclient.getTools();
    const filteredTools = semgrepTools.filter(tool => tool.name.includes('semgrep_scan'));
    
    return filteredTools;
  }

  private static initializeMCPClient() {
    return new MultiServerMCPClient({
      throwOnLoadError: true,
      useStandardContentBlocks: true,
      mcpServers: {
        'semgrep': {
          'transport': 'sse',
          'url': 'https://mcp.semgrep.ai/sse',
        },
      }
    });
  }

  public static async close() {
    if (this._mcpclient) {
      await this._mcpclient.close();
    }
  }
}