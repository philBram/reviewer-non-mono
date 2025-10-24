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
          RETURN d.id AS id, d.diffType AS diffType, d.source AS source, d.startLine AS startLine, 
                 d.endLine AS endLine, d.addedLines AS addedLines, 
                 d.removedLines AS removedLines, d.content AS content
          ORDER BY d.startLine ASC
        `;
        
        const results = await graph.query(cypherQuery, { filePath });

        return JSON.stringify({
          filePath: filePath,
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
          RETURN d.id AS id, d.diffType AS diffType, d.source AS source, d.startLine AS startLine, 
                 d.endLine AS endLine, d.addedLines AS addedLines, 
                 d.removedLines AS removedLines, d.content AS content
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
               END as extendsOrImplements,
               CASE 
                 WHEN collect(DISTINCT member) = [] THEN "no contained members"
                 ELSE collect(DISTINCT {
                   name: member.name, 
                   type: labels(member)[0],
                   source: member.source,
                   relationship: type(r2)
                 })
               END as containsMembers
          RETURN collect({
            type: labels(decl)[0],
            name: decl.name,
            source: decl.source,
            extendsOrImplements: extendsOrImplements,
            containsMembers: containsMembers
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
          diffId: diffId,
          affectedDeclarations: result[0].declarations,
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
                   hopsAway: length(path)
                 })
               END as impactedDeclarations
          RETURN {
            changedDeclaration: decl.name,
            changedType: labels(decl)[0],
            changedSource: decl.source,
            impactedDeclarations: impactedDeclarations
          } as impactAnalysis
        `;
        
        const graph = await this.graphClient;
        const result = await graph.query(cypherQuery, { diffId });
        
        return JSON.stringify({
          diffId: diffId,
          hops: hops,
          impactAnalysis: result.length > 0 ? result[0].impactAnalysis : null,
          message: result.length === 0 || result[0].impactAnalysis.impactedDeclarations === 'no impacted declarations'
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