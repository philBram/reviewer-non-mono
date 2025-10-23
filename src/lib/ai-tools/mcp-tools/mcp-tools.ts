import { MultiServerMCPClient } from '@langchain/mcp-adapters';

export class MCPTools {
  private static _mcpclient: MultiServerMCPClient;

  private constructor() {}

  public static async getSemgrepTools() {
    if (!this._mcpclient) {
      this._mcpclient = this.initializeMCPClient();
    }
    const semgrepTools = await this._mcpclient.getTools();
    semgrepTools
      .filter(tool => tool.name.includes('semgrep_scan'));

    return semgrepTools;
  }

  private static initializeMCPClient() {
    return new MultiServerMCPClient({
      throwOnLoadError: true,
      useStandardContentBlocks: true,
      mcpServers: {
        'semgrep': {
          'transport': 'http',
          'url': 'https://mcp.semgrep.ai/mcp',
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