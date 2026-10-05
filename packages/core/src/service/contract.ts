import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { canonicalJson } from '../reproduction/identity'
import type { ContractRef } from '../schema/service'

/**
 * M5b API-contract layer — pure functions over a repo-checked-in OpenAPI
 * document, no I/O of any kind. The document supplies deterministic RUNTIME
 * expectations for declared probes: which status an operation declares, and
 * the JSON schema its application/json response must satisfy. This is NOT an
 * OpenAPI compatibility analyzer (no spec-diffing) and NOT a general JSON
 * Schema validator (pinned keyword subset only, see SUPPORTED_SCHEMA_KEYWORDS).
 */

/** The parsed OpenAPI document object (JSON or YAML source — shape identical). */
export interface OpenApiDocument {
  [key: string]: unknown
}

/**
 * Parse an OpenAPI document from YAML or JSON text (JSON is a YAML subset, so
 * one parser covers both). null when the text is absent (null), syntactically
 * unparseable, or does not parse to a mapping — documents are objects by
 * definition, and every unusable state collapses to the uniform null. OpenAPI
 * SEMANTICS are not validated here.
 */
export function parseOpenApiDocument(text: string | null): OpenApiDocument | null {
  if (text === null) {
    return null
  }
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch {
    return null
  }
  return isRecord(raw) ? raw : null
}

/**
 * Deterministic digest of the PARSED document: 'oas_' + sha256 hex over
 * canonicalJson (recursively key-sorted, undefined-dropped). Formatting,
 * key order, quoting, and comments never reach the parsed object, so
 * semantically identical documents hash identically; any semantic change
 * (an operation, a schema, a status declaration) diverges.
 */
export function apiContractDigest(doc: OpenApiDocument): string {
  return `oas_${createHash('sha256').update(canonicalJson(doc), 'utf8').digest('hex')}`
}

export interface ResolvedContractExpectation {
  /** The response status the operation declares for the referenced response code. */
  status: number
  /** Declared JSON schema for application/json responses; undefined when the operation declares none (status-only contract). */
  schema?: unknown
}

export type ContractResolution =
  | { status: 'resolved'; expectation: ResolvedContractExpectation }
  | { status: 'unresolvable'; reason: string }

/** Local $ref chains longer than this are declared unresolvable (cycle-proofing by budget). */
const MAX_REF_DEPTH = 32

/**
 * Resolve paths.<path>.<method>.responses.<status> into an expectation.
 * Follows local $refs (JSON pointer, ~0/~1 unescaping, depth-capped) anywhere
 * along the way: the status entry, the content map, the media-type object,
 * and the schema itself. Non-local $refs (other files/URLs), broken pointers,
 * $ref cycles, and depth overflow are unresolvable — never silent passes.
 */
export function resolveContractExpectation(doc: OpenApiDocument, ref: ContractRef): ContractResolution {
  const methodKey = ref.method.toLowerCase()
  const operationLabel = `${ref.method} ${ref.path}`

  const paths: Record<string, unknown> = isRecord(doc.paths) ? doc.paths : {}
  const rawPathItem = paths[ref.path]
  const pathItem = isRecord(rawPathItem) ? rawPathItem : null
  const rawOperation = pathItem === null ? undefined : pathItem[methodKey]
  const operation = isRecord(rawOperation) ? rawOperation : null
  if (operation === null) {
    return unresolvable(`no operation ${operationLabel}`)
  }

  const responses: Record<string, unknown> = isRecord(operation.responses) ? operation.responses : {}
  const entry = responses[String(ref.status)]
  if (entry === undefined || entry === null) {
    return unresolvable(`no ${ref.status} response declared`)
  }

  const responseResult = derefChain(entry, doc)
  if (!responseResult.ok) {
    return unresolvable(responseResult.reason)
  }
  if (!isRecord(responseResult.value)) {
    return unresolvable(`${ref.status} response for ${operationLabel} is not an object`)
  }

  const schemaResult = locateJsonSchema(responseResult.value, doc)
  if (!schemaResult.ok) {
    return unresolvable(schemaResult.reason)
  }
  if (schemaResult.value === undefined) {
    return { status: 'resolved', expectation: { status: ref.status } }
  }
  return { status: 'resolved', expectation: { status: ref.status, schema: schemaResult.value } }
}

/** Response -> content -> application/json -> schema, each hop $ref-transparent; undefined = status-only contract. */
function locateJsonSchema(
  response: Record<string, unknown>,
  doc: OpenApiDocument,
): RefResult {
  const contentRaw = response.content
  if (contentRaw === undefined || contentRaw === null) {
    return ok(undefined)
  }
  const content = derefChain(contentRaw, doc)
  if (!content.ok) {
    return content
  }
  if (!isRecord(content.value)) {
    return ok(undefined)
  }
  // Exact media-type key only — 'application/json; charset=utf-8' etc. are
  // different declarations and are deliberately not matched.
  const mediaRaw = content.value['application/json']
  if (mediaRaw === undefined || mediaRaw === null) {
    return ok(undefined)
  }
  const media = derefChain(mediaRaw, doc)
  if (!media.ok) {
    return media
  }
  if (!isRecord(media.value)) {
    return ok(undefined)
  }
  const schemaRaw = media.value.schema
  if (schemaRaw === undefined || schemaRaw === null) {
    return ok(undefined)
  }
  const direct = derefChain(schemaRaw, doc)
  if (!direct.ok) {
    return direct
  }
  return deepResolveSchema(direct.value, doc, MAX_REF_DEPTH, new Set())
}

// ---------------------------------------------------------------------------
// Local $ref machinery (JSON pointer, RFC 6901 tokens with ~0/~1 unescaping)
// ---------------------------------------------------------------------------

type RefResult = { ok: true; value: unknown } | { ok: false; reason: string }

const ok = (value: unknown): RefResult => ({ ok: true, value })
const fail = (reason: string): RefResult => ({ ok: false, reason })
const unresolvable = (reason: string): ContractResolution => ({ status: 'unresolvable', reason })

/** Resolve `value` while it IS a $ref object (a $ref replaces its object wholesale; siblings are ignored). */
function derefChain(value: unknown, doc: OpenApiDocument): RefResult {
  let current = value
  const seen = new Set<string>()
  for (let depth = 0; isRefObject(current); depth++) {
    const ref = current.$ref
    if (!ref.startsWith('#')) {
      return fail(`non-local $ref "${ref}" cannot be resolved`)
    }
    if (seen.has(ref)) {
      return fail(`$ref cycle detected at "${ref}"`)
    }
    if (depth >= MAX_REF_DEPTH) {
      return fail(`$ref depth exceeds ${MAX_REF_DEPTH}`)
    }
    seen.add(ref)
    const target = resolvePointer(doc, ref.slice(1))
    if (!target.ok) {
      return target
    }
    current = target.value
  }
  return ok(current)
}

/**
 * Deeply resolve every local $ref inside a schema so the result is
 * self-contained. The `seen` set is the CURRENT reference chain (backtracked
 * on return): diamond references to the same target from two properties are
 * fine, only a true cycle fails. Data-carrying keys (enum values, examples,
 * defaults) are constants, not schemas, and are never dereferenced.
 */
function deepResolveSchema(
  value: unknown,
  doc: OpenApiDocument,
  budget: number,
  seen: ReadonlySet<string>,
): RefResult {
  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const element of value) {
      const resolved = deepResolveSchema(element, doc, budget, seen)
      if (!resolved.ok) {
        return resolved
      }
      items.push(resolved.value)
    }
    return ok(items)
  }
  if (!isRecord(value)) {
    return ok(value)
  }
  if (isRefObject(value)) {
    const ref = value.$ref
    if (!ref.startsWith('#')) {
      return fail(`non-local $ref "${ref}" cannot be resolved`)
    }
    if (seen.has(ref)) {
      return fail(`$ref cycle detected at "${ref}"`)
    }
    if (budget <= 0) {
      return fail(`$ref depth exceeds ${MAX_REF_DEPTH}`)
    }
    const target = resolvePointer(doc, ref.slice(1))
    if (!target.ok) {
      return target
    }
    const nextSeen = new Set(seen)
    nextSeen.add(ref)
    return deepResolveSchema(target.value, doc, budget - 1, nextSeen)
  }
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    if (DATA_KEYS.has(key)) {
      result[key] = value[key]
      continue
    }
    const resolved = deepResolveSchema(value[key], doc, budget, seen)
    if (!resolved.ok) {
      return resolved
    }
    result[key] = resolved.value
  }
  return ok(result)
}

/** Keys whose values are inline DATA (constants/examples), not sub-schemas. */
const DATA_KEYS = new Set(['enum', 'example', 'examples', 'default'])

function resolvePointer(doc: OpenApiDocument, fragment: string): RefResult {
  if (fragment === '') {
    return ok(doc)
  }
  const tokens = fragment.startsWith('/') ? fragment.slice(1).split('/') : [fragment]
  let current: unknown = doc
  for (const token of tokens) {
    const key = unescapePointerToken(token)
    if (isRecord(current)) {
      if (!hasOwn(current, key)) {
        return fail(`$ref pointer does not resolve: "${key}" not found`)
      }
      current = current[key]
    } else if (Array.isArray(current) && /^\d+$/.test(key)) {
      const index = Number(key)
      if (index >= current.length) {
        return fail(`$ref pointer does not resolve: index ${index} out of bounds`)
      }
      current = current[index]
    } else {
      return fail(`$ref pointer does not resolve: "${key}" cannot index a ${describeToken(current)}`)
    }
  }
  return ok(current)
}

/** RFC 6901: ~1 escapes '/', ~0 escapes '~' (order matters: ~1 first, so '~01' unescapes to literal '~1'). */
function unescapePointerToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~')
}

// ---------------------------------------------------------------------------
// Pinned JSON Schema subset validation
// ---------------------------------------------------------------------------

/**
 * The explicit v1 pin list: the ONLY schema keywords checkAgainstSchema
 * understands. Everything else — `pattern`, `format`, `minimum`, `oneOf`,
 * object-form `additionalProperties`, … — is REPORTED as unsupported, never
 * silently ignored, because an ignored constraint would manufacture a pass
 * the spec never declared.
 */
export const SUPPORTED_SCHEMA_KEYWORDS: readonly string[] = Object.freeze([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'nullable',
  'additionalProperties',
])

const SUPPORTED_KEYWORDS = new Set(SUPPORTED_SCHEMA_KEYWORDS)
const TYPE_VALUES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])

export type SchemaCheck =
  | { verdict: 'valid' }
  | { verdict: 'invalid'; reason: string }
  | { verdict: 'unsupported'; keyword: string }

/**
 * Validate a parsed JSON value against a schema from the PINNED subset.
 * Unsupported constructs anywhere in the (already $ref-resolved) schema are
 * reported before and independently of validation — a schema that would pass
 * but contains `format` is unsupported, not valid. Failure reasons name the
 * JSON path of the violation (e.g. '.tasks[1].id').
 */
export function checkAgainstSchema(value: unknown, schema: unknown): SchemaCheck {
  const unsupported = scanUnsupported(schema)
  if (unsupported !== null) {
    return { verdict: 'unsupported', keyword: unsupported }
  }
  const invalid = validate(value, schema as Record<string, unknown>, '')
  return invalid === null ? { verdict: 'valid' } : { verdict: 'invalid', reason: invalid }
}

/**
 * Deterministic unsupported-keyword scan: pre-order walk, keys visited in
 * sorted order, recursing only into schema positions (properties values,
 * items). Returns the offending keyword, or null when the whole schema is
 * pinned. Malformed values for pinned keywords (non-boolean nullable,
 * non-array enum, object-form additionalProperties, tuple-form items,
 * unknown type token) are unsupported too — reported with that keyword.
 */
function scanUnsupported(schema: unknown): string | null {
  if (!isRecord(schema)) {
    return describeToken(schema)
  }
  for (const key of Object.keys(schema).sort()) {
    const value = schema[key]
    switch (key) {
      case 'type':
        if (typeof value !== 'string') {
          return 'type'
        }
        if (!TYPE_VALUES.has(value)) {
          return value
        }
        break
      case 'properties':
        if (!isRecord(value)) {
          return 'properties'
        }
        for (const name of Object.keys(value).sort()) {
          const nested = scanUnsupported(value[name])
          if (nested !== null) {
            return nested
          }
        }
        break
      case 'items':
        // Tuple form (array of schemas) is not in the pinned subset.
        if (Array.isArray(value)) {
          return 'items'
        }
        {
          const nested = scanUnsupported(value)
          if (nested !== null) {
            return nested
          }
        }
        break
      case 'enum':
        if (!Array.isArray(value)) {
          return 'enum'
        }
        break
      case 'nullable':
        if (typeof value !== 'boolean') {
          return 'nullable'
        }
        break
      case 'required':
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
          return 'required'
        }
        break
      case 'additionalProperties':
        if (typeof value !== 'boolean') {
          return 'additionalProperties'
        }
        break
      default:
        if (!SUPPORTED_KEYWORDS.has(key)) {
          return key
        }
        break
    }
  }
  return null
}

/**
 * Validate against a schema already known to be pinned. Deterministic check
 * order per node: type (with the nullable null short-circuit), enum,
 * required, properties (sorted names), additionalProperties, items (element
 * order). Returns the first violation's reason, or null.
 */
function validate(value: unknown, schema: Record<string, unknown>, path: string): string | null {
  const label = path === '' ? '(root)' : path
  const type = schema.type

  // OAS-style null handling: null is accepted only by explicit opt-in —
  // nullable: true, type: null, or an enum containing null.
  if (value === null) {
    if (schema.nullable === true || type === 'null') {
      return null
    }
    if (Array.isArray(schema.enum) && schema.enum.some((entry) => sameValueZero(entry, null))) {
      return null
    }
    if (type !== undefined) {
      return `${label} expected ${type}, got null`
    }
    return `${label} null is not allowed (schema is not nullable)`
  }

  if (typeof type === 'string' && !typeMatches(value, type)) {
    return `${label} expected ${type}, got ${describeValue(value)}`
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => sameValueZero(entry, value))) {
    return `${label} value is not in the schema enum`
  }

  if (isPlainObject(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name === 'string' && !hasOwn(value, name)) {
          return `${label} missing required property "${name}"`
        }
      }
    }
    for (const name of Object.keys(properties).sort()) {
      if (!hasOwn(value, name)) {
        continue
      }
      const subSchema = properties[name]
      if (!isRecord(subSchema)) {
        continue
      }
      const nested = validate(value[name], subSchema, path === '' ? `.${name}` : `${path}.${name}`)
      if (nested !== null) {
        return nested
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value).sort()) {
        if (!hasOwn(properties, key)) {
          return `${path === '' ? '' : path}.${key} is not an allowed property (additionalProperties is false)`
        }
      }
    }
  }

  if (Array.isArray(value) && isRecord(schema.items)) {
    for (let index = 0; index < value.length; index++) {
      const nested = validate(value[index], schema.items, `${path}[${index}]`)
      if (nested !== null) {
        return nested
      }
    }
  }

  return null
}

/** integer accepts JS numbers with integral value; number accepts any finite number. */
function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
    case 'null':
      return value === null
    default:
      return false
  }
}

/** Object.is plus the SameValueZero +0/-0 equivalence (NaN already equals itself under Object.is). */
function sameValueZero(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true
  }
  return a === 0 && b === 0
}

const DESCRIBE_STRING_LIMIT = 40

/** Human token for an unsupported schema node: booleans/numbers/null render as themselves. */
function describeToken(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  if (typeof value === 'object') {
    return 'object'
  }
  return String(value)
}

/** Bounded value description for invalid reasons — names the JSON type and the offending value. */
function describeValue(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  switch (typeof value) {
    case 'string':
      return `string "${value.length <= DESCRIBE_STRING_LIMIT ? value : `${value.slice(0, DESCRIBE_STRING_LIMIT)}…`}"`
    case 'number':
      return Number.isFinite(value) ? `number ${value}` : String(value)
    case 'boolean':
      return `boolean ${value}`
    case 'object':
      return 'object'
    default:
      return typeof value
  }
}

// ---------------------------------------------------------------------------
// Shared small helpers (module-private)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
}

function isRefObject(value: unknown): value is { $ref: string } {
  return isRecord(value) && typeof value.$ref === 'string'
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}
