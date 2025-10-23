import { Neo4jGraph } from '@langchain/community/graphs/neo4j_graph';
import { tool } from '@langchain/core/tools';
import { Neo4jClient } from '../../ai-utils';
import { z } from 'zod';

export class Neo4jGraphDbTools {
  private readonly graphClient: Promise<Neo4jGraph>;

  constructor() {
    this.graphClient = Neo4jClient.getClient();
  }

  findChanges() {
    const schema = z.object({
      filePath: z.string().describe('Full file path or filename to search for DIFF_HUNKs. Can be full path like "root/src/example/file.ts" or just filename like "file.ts"'),
    });

    return tool(
      async (input) => {
        const { filePath } = schema.parse(input);

        const graph = await this.graphClient;
        
        const cypherQuery = `
          MATCH (d:DIFF_HUNK)
          WHERE d.source = $filePath OR d.source ENDS WITH $filePath
          RETURN d.id AS id, d.name AS name, d.source AS source, d.start_line AS start_line, 
                 d.end_line AS end_line, d.added_lines AS added_lines, 
                 d.removed_lines AS removed_lines, d.commit_id AS commit_id, d.content AS content
          ORDER BY d.start_line ASC
        `;
        
        const results = await graph.query(cypherQuery, { filePath });

        return JSON.stringify({
          file_path: filePath,
          count: results.length,
          changes: results,
        }, null, 2);
      },
      {
        name: 'find_changes',
        description: 'PRIMARY TOOL: Find all code changes (DIFF_HUNKs) for a specific file. Provide the file path (full or filename only) to find DIFF_HUNKs.',
        schema: schema,
      }
    );
  }

  findDiffHunk() {
    const schema = z.object({
      diffId: z.string().describe('The unique ID of the diff hunk to retrieve'),
    });

    return tool(
      async (input) => {
        const { diffId } = schema.parse(input);

        const graph = await this.graphClient;
        
        const cypherQuery = `
          MATCH (d:DIFF_HUNK {id: $diffId})
          RETURN d.id AS id, d.name AS name, d.source AS source, d.start_line AS start_line, 
                 d.end_line AS end_line, d.added_lines AS added_lines, 
                 d.removed_lines AS removed_lines, d.commit_id AS commit_id, d.content AS content
        `;
        
        const results = await graph.query(cypherQuery, { diffId });

        if (results.length === 0) {
          return JSON.stringify({
            error: `No diff found with ID: ${diffId}`
          }, null, 2);
        }

        return JSON.stringify({
          diff: results[0],
        }, null, 2);
      },
      {
        name: 'find_diff_hunk',
        description: 'Retrieve a specific diff hunk by its unique ID.',
        schema: schema,
      }
    );
  }

  findSimilarChanges() {
    const schema = z.object({
      diffId: z.string().describe('The diff ID to find similar changes for'),
      topK: z.number().min(1).max(20).default(5).describe('Number of similar changes to return'),
    });

    return tool(
      async (input) => {
        const { diffId, topK } = schema.parse(input);
        
        const cypherQuery = `
          MATCH (target:DIFF_HUNK {id: $diffId})
          CALL db.index.vector.queryNodes('diff_vector_index', $topK, target.embedding)
          YIELD node, score
          WHERE node.id <> $diffId
          RETURN node.id AS id, 
                node.source AS source,
                node.content AS content,
                node.start_line AS start_line,
                node.end_line AS end_line,
                score
          ORDER BY score DESC
        `;
        
        const graph = await this.graphClient;
        const result = await graph.query(cypherQuery, { diffId, topK });
        
        return JSON.stringify({
          diff_id: diffId,
          similar_changes: result,
          message: 'These are semantically similar changes that might have been reviewed before'
        }, null, 2);
      },
      {
        name: 'find_similar_changes',
        description: 'Find semantically similar code changes using vector embeddings. Useful for finding patterns, similar bugs, or past reviews of similar code changes.',
        schema: schema,
      }
    );
  }

  findAffectedDeclarations() {
    const schema = z.object({
      diffId: z.string().describe('The unique ID of the diff hunk (obtained from find_changes)'),
    });

    return tool(
      async (input) => {
        const { diffId } = schema.parse(input);
        
        const cypherQuery = `
          MATCH (decl)-[:HAS_DIFF]->(diff:DIFF_HUNK {id: $diffId})
          OPTIONAL MATCH (decl)-[r1:EXTENDS|IMPLEMENTS]->(inherited)
          OPTIONAL MATCH (decl)-[r2:CONTAINS]->(member)
          WITH decl, 
               CASE 
                 WHEN collect(DISTINCT inherited) = [] THEN "no extends or implements"
                 ELSE collect(DISTINCT {
                   name: inherited.name,
                   type: labels(inherited)[0],
                   source: inherited.source,
                   relationship: type(r1)
                 })
               END as extends_or_implements,
               CASE 
                 WHEN collect(DISTINCT member) = [] THEN "no contained members"
                 ELSE collect(DISTINCT {
                   name: member.name, 
                   type: labels(member)[0],
                   source: member.source,
                   relationship: type(r2)
                 })
               END as contains_members
          RETURN collect({
            type: labels(decl)[0],
            name: decl.name,
            source: decl.source,
            extends_or_implements: extends_or_implements,
            contains_members: contains_members
          }) as declarations
        `;
        
        const graph = await this.graphClient;
        const result = await graph.query(cypherQuery, { diffId });
        
        if (result.length === 0) {
          return JSON.stringify({
            error: `No diff found with ID: ${diffId}`,
            suggestion: 'Use find_changes to get valid diff IDs'
          }, null, 2);
        }

        return JSON.stringify({
          diff_id: diffId,
          affected_declarations: result[0].declarations,
        }, null, 2);
      },
      {
        name: 'find_affected_declarations',
        description: 'Get the context of declarations (classes/methods/functions) affected by a diff. Shows declaration details, inheritance relationships (EXTENDS/IMPLEMENTS), and contained members (CONTAINS). Use the diff ID from find_changes.',
        schema: schema,
      }
    );
  }

  findImpactedDeclarations() {
    const schema = z.object({
      diffId: z.string().describe('The unique ID of the diff hunk'),
      hops: z.number().min(1).max(5).default(1).describe('Number of relationship hops to follow (1 = direct dependents, 2 = indirect dependents 1 level away, etc.)'),
    });

    return tool(
      async (input) => {
        const { diffId, hops } = schema.parse(input);
        
        const cypherQuery = `
          MATCH (decl)-[:HAS_DIFF]->(diff:DIFF_HUNK {id: $diffId})
          OPTIONAL MATCH path = (dependent)-[:CALLS|EXTENDS|IMPLEMENTS*1..${hops}]->(decl)
          WITH decl,
               CASE 
                 WHEN collect(DISTINCT dependent) = [] THEN "no impacted declarations"
                 ELSE collect(DISTINCT {
                   name: dependent.name,
                   type: labels(dependent)[0],
                   source: dependent.source,
                   hops_away: length(path)
                 })
               END as impacted_declarations
          RETURN {
            changed_declaration: decl.name,
            changed_type: labels(decl)[0],
            changed_source: decl.source,
            impacted_declarations: impacted_declarations
          } as impact_analysis
        `;
        
        const graph = await this.graphClient;
        const result = await graph.query(cypherQuery, { diffId });
        
        return JSON.stringify({
          diff_id: diffId,
          hops: hops,
          impact_analysis: result.length > 0 ? result[0].impact_analysis : null,
          message: result.length === 0 || result[0].impact_analysis.impacted_declarations === 'no impacted declarations'
            ? `No declarations found that depend on this change within ${hops} hop(s). This change may be isolated or internal.`
            : undefined
        }, null, 2);
      },
      {
        name: 'find_impacted_declarations',
        description: 'Find what declarations depend on the declarations that were changed in a diff, up to a specified number of relationship hops away. Supports variable-length paths to find both direct dependents (1 hop) and indirect dependents through the call graph. Relationship types: CALLS, EXTENDS, IMPLEMENTS.',
        schema: schema,
      }
    );
  }
}