import { Neo4jClient } from '../../lib/ai-utils';

export async function getAllDiffHunks() {
  const graph = await Neo4jClient.getClient();

  const cypherQuery = `
    MATCH (d:DIFF_HUNK)
    RETURN 
      d.id AS id,
      d.source AS source,
      d.startLine AS startLine,
      d.endLine AS endLine,
      d.content AS content,
      d.commitId AS commitId
    ORDER BY d.source, d.startLine ASC
  `;

  const results = await graph.query(cypherQuery, {});

  return results.map(row => ({
    id: row.id,
    source: row.source,
    startLine: row.startLine,
    endLine: row.endLine,
    content: row.content,
    commitId: row.commitId,
  }));
}