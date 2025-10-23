import { z } from 'zod';

const securityScan = z.object({
  involved_file: z.string().describe('File path where the issue is located.'),
  results: z.string().describe('Summary of security findings identified in the file or empty if none.'),
});

const job = z.object({
  diff_id: z.string().describe('The unique ID of the diff hunk'),
  reason: z.string().describe('security|guidelines|impact|mixed'),
  summary: z.string().describe('Brief explanation of why this change was flagged (<= 300 chars prefered)'),
  impacted: z.boolean().default(false).describe('Whether planner found this hunk has impact (affects multiple declarations). If true, reviewer can skip find_impacted_declarations to save cost.'),
});

const review = z.object({
  diff_id: z.string().describe('The unique ID of the diff hunk'),
  suggestion: z.string().describe('Actionable feedback (prefer <= 300 characters)'),
  code_suggestion: z.string().describe('Short code suggestion that illustrates a possible fix (prefer <= 10 lines).'),
  type: z.enum(['blocker', 'comment']).describe('Severity/type of the feedback.'),
});

export const securityScanSchema = 
z.object({
  items: z.array(securityScan),
});

export const jobsSchema = 
z.object({ 
  items: z.array(job),
});

export const reviewsSchema = 
z.object({
  items: z.array(review),
});

export type ModelJobsOutput = z.infer<typeof job>;
export type ModelReviewsOutput = z.infer<typeof review>;
export type ModelSecurityScanOutput = z.infer<typeof securityScan>;
  