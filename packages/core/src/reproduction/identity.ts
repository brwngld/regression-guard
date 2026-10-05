import { createHash } from 'node:crypto'
import type { StateIdentity } from '../schema/reproduction'

/**
 * M4 lineage identity — two deliberately distinct notions:
 *
 * - verificationContextId: a deterministic content hash of (contract identity
 *   + before/after state identities + finding identities). It answers "is this
 *   logically the same verification situation?" across runs and repair loops.
 * - verificationRunId: a unique execution identifier (context prefix + time
 *   suffix). It answers "which actual execution produced this evidence?".
 *
 * Everything here is pure and deterministic: the same logical input always
 * yields the same context id, on every machine, in every timezone.
 */

export interface LineageInput {
  contractId: string
  contractVersion: number
  before: StateIdentity
  after: StateIdentity
  /** Sorted upstream; sorted defensively anyway so ordering cannot drift the id. */
  findingIds: string[]
}

/** Canonical JSON stringify with recursively sorted keys (for hashing). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/**
 * Deterministic comparison identity: full sha256 hex over the canonical
 * lineage, prefixed 'ctx_'.
 */
export function verificationContextId(input: LineageInput): string {
  const payload = {
    contractId: input.contractId,
    contractVersion: input.contractVersion,
    before: canonicalStateIdentity(input.before),
    after: canonicalStateIdentity(input.after),
    findingIds: [...input.findingIds].sort(),
  }
  return `ctx_${sha256Hex(canonicalJson(payload))}`
}

/**
 * Unique execution id: 'run_' + first 12 hex of the context hash + '_' + a
 * basic ISO timestamp (YYYYMMDDTHHMMSSZ, UTC). The context prefix keeps run
 * ids traceable to their lineage; the timestamp keeps executions distinct.
 */
export function verificationRunId(contextId: string, at: Date = new Date()): string {
  const hex = contextId.startsWith('ctx_') ? contextId.slice('ctx_'.length) : contextId
  return `run_${hex.slice(0, 12)}_${basicIsoUtc(at)}`
}

/** Recursively sort object keys and drop undefined fields so hashing is stable. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    // Arrays are order-sensitive data, not maps: order is preserved.
    return value.map(canonicalize)
  }
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    const entry = source[key]
    if (entry === undefined) {
      continue
    }
    result[key] = canonicalize(entry)
  }
  return result
}

/** Stable StateIdentity shape: optional fields are omitted, never `undefined`. */
function canonicalStateIdentity(identity: StateIdentity): Record<string, unknown> {
  const result: Record<string, unknown> = {
    label: identity.label,
    kind: identity.kind,
    sha: identity.sha,
  }
  if (identity.baseSha !== undefined) {
    result.baseSha = identity.baseSha
  }
  if (identity.fingerprint !== undefined) {
    result.fingerprint = identity.fingerprint
  }
  return result
}

function basicIsoUtc(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`
  )
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}
