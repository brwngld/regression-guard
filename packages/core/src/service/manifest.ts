import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { canonicalJson } from '../reproduction/identity'
import { ServiceManifestSchema, type ServiceManifest } from '../schema/service'

/**
 * M5 service manifest loading and identity.
 *
 * The manifest (regression-guard.services.yaml) is repo-declared trusted
 * input, parsed exactly like change contracts: YAML → zod. parseServiceManifest
 * never throws — absent, syntactically broken, and structurally invalid
 * manifests all collapse to null so callers can treat "no usable manifest"
 * as one uniform state. loadServiceManifest keeps those outcomes apart:
 * absent means "no verification was declared", invalid means "verification
 * was declared incorrectly" — different facts with different remedies.
 */

/** Discriminated manifest load outcome; never throws, never merges states. */
export type ManifestLoadResult =
  | { status: 'absent' }
  | { status: 'valid'; manifest: ServiceManifest; digest: string }
  /** zod issue paths + messages (`<path>: <message>`), or the YAML parser message; deterministic order. */
  | { status: 'invalid'; errors: string[] }

/**
 * Load a manifest text and report WHICH failure mode occurred.
 *
 * - null or whitespace-only text → absent (nothing was declared)
 * - YAML parse error → invalid with the parser message
 * - schema failure → invalid with issues formatted `<path>: <message>`
 *   (root-level issues carry the bare message), sorted lexicographically
 * - success → valid with the parsed manifest and its manifestDigest
 *
 * A document that parses to null without being whitespace (e.g. comments
 * only) is schema-invalid, not absent: something was declared and it is
 * not a manifest.
 */
export function loadServiceManifest(text: string | null): ManifestLoadResult {
  if (text === null || text.trim() === '') {
    return { status: 'absent' }
  }
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    return { status: 'invalid', errors: [(error as Error).message] }
  }
  const result = ServiceManifestSchema.safeParse(raw)
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => {
        const path = issue.path.map(String).join('.')
        return path ? `${path}: ${issue.message}` : issue.message
      })
      .sort()
    return { status: 'invalid', errors }
  }
  return { status: 'valid', manifest: result.data, digest: manifestDigest(result.data) }
}

/** null when the text is absent (null), unparseable YAML, or fails schema validation. */
export function parseServiceManifest(text: string | null): ServiceManifest | null {
  const result = loadServiceManifest(text)
  return result.status === 'valid' ? result.manifest : null
}

/**
 * Deterministic identity of the PARSED manifest: 'svc_' + sha256 hex over
 * canonicalJson (recursively key-sorted, undefined-dropped). Semantically
 * identical manifests — different formatting, different key order, defaults
 * spelled out or omitted (zod fills them) — hash identically; any declared
 * rule difference diverges.
 */
export function manifestDigest(manifest: ServiceManifest): string {
  return `svc_${createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex')}`
}
