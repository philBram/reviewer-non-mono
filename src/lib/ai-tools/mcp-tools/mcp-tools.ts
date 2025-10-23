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

  public static async getGitHubPRTools() {
    if (!this._mcpclient) {
      this._mcpclient = this.initializeMCPClient();
    }
    const tools = await this._mcpclient.getTools();
    
    return tools.filter(tool => 
      tool.name === 'pull_request_review_write' || 
      tool.name === 'add_comment_to_pending_review'
    );
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
        'github': {
          'transport': 'http',
          'url': 'https://api.githubcopilot.com/mcp/',
          'headers': {
            'Authorization': `Bearer ${process.env.GITHUB_TOKEN || ''}`
          }
        }
      }
    });
  }

  public static async close() {
    if (this._mcpclient) {
      await this._mcpclient.close();
    }
  }
}