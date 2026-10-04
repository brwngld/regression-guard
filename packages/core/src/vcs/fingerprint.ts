import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChangeRecord } from '../schema/changeset'
import type { GitAdapter } from './git'

/** One record with its materialized content, ready for fingerprinting. */
export interface FingerprintRecord {
  path: string
  oldPath?: string
  status: string
  /** File content at the verified state; null when the file is absent (deleted). */
  content: string | null
}

/** Deterministic fingerprint over a set of changed paths + their content. */
export function fingerprintRecords(records: FingerprintRecord[]): string {
  // Code-unit (not locale-aware) comparison keeps the sort stable across
  // machines and ICU builds; the rendered line breaks pathological path ties.
  const lines = records
    .map((record) => ({
      path: record.path,
      line: renderLine(record),
    }))
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : left.line < right.line ? -1 : 1,
    )
    .map((entry) => entry.line)
  return `sha256:${sha256Hex(lines.join('\n'))}`
}

/** Read each changed file from the repository working tree and fingerprint. */
export async function workingTreeFingerprint(git: GitAdapter, records: ChangeRecord[]): Promise<string> {
  const materialized = await Promise.all(
    records.map(async (record): Promise<FingerprintRecord> => {
      let content: string | null
      try {
        // Reading everything as utf8 — including binaries — is deliberate:
        // the goal is stable identity (same bytes → same string → same hash),
        // not lossless decoding.
        content = await readFile(join(git.repoRoot, record.path), 'utf8')
      } catch {
        // The file is absent from the working tree (e.g. deleted); expected
        // for status 'deleted', tolerated for any other status.
        content = null
      }
      return { path: record.path, oldPath: record.oldPath, status: record.status, content }
    }),
  )
  return fingerprintRecords(materialized)
}

function renderLine(record: FingerprintRecord): string {
  const origin = record.oldPath ? ` <- ${record.oldPath}` : ''
  const digest = record.content === null ? '(absent)' : sha256Hex(record.content)
  return `${record.status} ${record.path}${origin} ${digest}`
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}
