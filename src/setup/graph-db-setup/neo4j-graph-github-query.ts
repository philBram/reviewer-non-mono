import { Neo4jClient } from '../../lib/ai-utils';

export async function getAllDiffHunks() {
  const graph = await Neo4jClient.getClient();

  const cypherQuery = `
    MATCH (d:DIFF_HUNK)
    RETURN 
      d.id AS id,
      d.source AS source,
      d.start_line AS start_line,
      d.end_line AS end_line,
      d.content AS content,
      d.commit_id AS commit_id
    ORDER BY d.source, d.start_line ASC
  `;

  const results = await graph.query(cypherQuery, {});

  return results.map(row => ({
    id: row.id,
    source: row.source,
    start_line: row.start_line,
    end_line: row.end_line,
    content: row.content,
    commit_id: row.commit_id,
  }));
}