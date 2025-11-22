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
                 d.removedLines AS removedLines
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
                 d.removedLines AS removedLines
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
          OPTIONAL MATCH (decl)-[r:EXTENDS|IMPLEMENTS]->(inherited)
          WITH decl, 
               CASE 
                 WHEN collect(DISTINCT inherited) = [] THEN "no extends or implements"
                 ELSE collect(DISTINCT {
                   name: inherited.name,
                   type: labels(inherited)[0],
                   source: inherited.source,
                   relationship: type(r)
                 })
               END as extendsOrImplements
          RETURN collect({
            type: labels(decl)[0],
            name: decl.name,
            source: decl.source,
            extendsOrImplements: extendsOrImplements
          }) as declarations
        `;
        
        const graph = await this.graphClient;
        const result = await graph.query(cypherQuery, { diffId });
        
        if (result.length === 0) {
          return JSON.stringify({
            error: `No diff found with ID: ${diffId}`,
          }, null, 2);
        }

        return JSON.stringify({
          diffId: diffId,
          affectedDeclarations: result[0].declarations,
        }, null, 2);
      },
      {
        name: 'find_affected_declarations',
        description: 'Get the context of declarations (classes/methods/functions) affected by a diff. Shows declaration details and inheritance relationships (EXTENDS/IMPLEMENTS).',
        schema: schema,
      }
    );
  }

  findImpactedDeclarations() {
    const schema = z.object({
      diffId: z.string().describe('The unique ID of the diff hunk'),
      hops: z.number().min(1).max(3).default(1).describe('Number of relationship hops to follow (1 = direct dependents, 2 = indirect dependents 1 level away, etc.)'),
    });

    return tool(
      async (input) => {
        const { diffId, hops } = schema.parse(input);
        
        const cypherQuery = `
          MATCH (decl)-[:HAS_DIFF]->(diff:DIFF_HUNK {id: $diffId})
          WITH COLLECT(decl) as changedDecls
          UNWIND changedDecls as changedDecl
          OPTIONAL MATCH path = (changedDecl)<-[:CALLS|EXTENDS|IMPLEMENTS*1..${hops}]-(dependent)
          WITH changedDecl,
               COLLECT(DISTINCT {
                 name: dependent.name,
                 type: labels(dependent)[0],
                 source: dependent.source,
                 hopsAway: length(path)
               }) as dependents
          RETURN {
            changedDeclaration: changedDecl.name,
            changedType: labels(changedDecl)[0],
            changedSource: changedDecl.source,
            impactedDeclarations: dependents
          } as impactAnalysis
        `;
        
        const graph = await this.graphClient;
        const result = await graph.query(cypherQuery, { diffId });
        
        return JSON.stringify({
          diffId: diffId,
          hops: hops,
          impactAnalysis: result.length > 0 ? result : [],
          message: result.length === 0 
            ? `No declarations found with changes in this diff.` : ''
        }, null, 2);
      },
      {
        name: 'find_impacted_declarations',
        description: 'Find all declarations affected by a diff, and what other declarations depend on those changed declarations. Returns multiple impact analyses - one for each declaration directly affected by the diff. Use this to understand the scope of changes and their dependents.',
        schema: schema,
      }
    );
  }
}