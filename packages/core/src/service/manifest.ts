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
 * as one uniform state.
 */

/** null when the text is absent (null), unparseable YAML, or fails schema validation. */
export function parseServiceManifest(text: string | null): ServiceManifest | null {
  if (text === null) {
    return null
  }
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch {
    return null
  }
  const result = ServiceManifestSchema.safeParse(raw)
  return result.success ? result.data : null
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
