import { z } from 'zod'
import type { SensitiveCategory } from './contract'

export const ChangeStatusSchema = z.enum(['modified', 'created', 'deleted', 'renamed'])
export type ChangeStatus = z.infer<typeof ChangeStatusSchema>

export const HunkSummarySchema = z.object({
  beforeStart: z.number().int(),
  beforeCount: z.number().int(),
  afterStart: z.number().int(),
  afterCount: z.number().int(),
  added: z.number().int(),
  removed: z.number().int(),
})
export type HunkSummary = z.infer<typeof HunkSummarySchema>

export const ChangeRecordSchema = z.object({
  /** Canonical path (the new path for renames), repo-root relative, forward slashes. */
  path: z.string(),
  /** Original path, only present for detected renames. */
  oldPath: z.string().optional(),
  status: ChangeStatusSchema,
  binary: z.boolean().default(false),
  hunks: z.array(HunkSummarySchema).default([]),
  /** -1 when the diff is binary and line counts are unavailable. */
  addedLines: z.number().int().default(0),
  removedLines: z.number().int().default(0),
  /** Sensitive-file categories detected for this path (enrichment step). */
  categories: z.array(z.string()).default([]),
})
export type ChangeRecord = z.infer<typeof ChangeRecordSchema>

export const DependencyChangeSchema = z.object({
  name: z.string(),
  section: z.string(),
  version: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
})
export type DependencyChange = z.infer<typeof DependencyChangeSchema>

export const DependencyChangesSchema = z.object({
  added: z.array(DependencyChangeSchema).default([]),
  removed: z.array(DependencyChangeSchema).default([]),
  changed: z.array(DependencyChangeSchema).default([]),
})

export const ChangeSetSchema = z.object({
  before: z.string(),
  after: z.string(),
  beforeSha: z.string(),
  // Null in working-tree mode — the tested state is HEAD plus a dirty overlay,
  // which no commit SHA identifies.
  afterSha: z.string().nullable(),
  // Present only in working-tree mode; fingerprint deterministically identifies
  // the materialized dirty state.
  workingTree: z.object({ baseSha: z.string(), fingerprint: z.string() }).optional(),
  records: z.array(ChangeRecordSchema).default([]),
})
export type ChangeSet = z.infer<typeof ChangeSetSchema>

export type EnrichedRecord = ChangeRecord & {
  categories: SensitiveCategory[]
  isTest: boolean
}

export type EnrichedChangeSet = {
  changeSet: ChangeSet
  records: EnrichedRecord[]
  dependencies: {
    added: DependencyChange[]
    removed: DependencyChange[]
    changed: DependencyChange[]
  }
}
