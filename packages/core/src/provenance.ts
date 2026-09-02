import { z } from 'zod';

export const SOURCE_KINDS = ['transcript', 'message', 'doc', 'issue', 'comment'] as const;
export const sourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** One access rule captured from a source's origin system. */
export const aclPrincipalRuleSchema = z.object({
  /** the kind of resource this rule governs, e.g. "slack_channel", "gdrive_file" */
  scope: z.string().min(1),
  /** external id of the specific resource */
  resourceId: z.string().min(1),
  /** external principal ids (users, groups) granted access */
  principals: z.array(z.string()).default([]),
  /** true when the resource is open to the whole origin workspace/org */
  public: z.boolean().default(false),
});
export type AclPrincipalRule = z.infer<typeof aclPrincipalRuleSchema>;

/**
 * Point-in-time capture of who could see a source artifact in its origin system.
 * Re-checked live at query time for Slack; refreshed on a schedule otherwise.
 */
export const aclSnapshotSchema = z.object({
  rules: z.array(aclPrincipalRuleSchema),
  capturedAt: z.string().datetime(),
  /** seconds this snapshot may be trusted before a refresh is required */
  ttlSeconds: z.number().int().positive(),
});
export type AclSnapshot = z.infer<typeof aclSnapshotSchema>;
