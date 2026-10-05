import { describe, expect, it } from 'vitest'
import {
  apiContractDigest,
  checkAgainstSchema,
  parseOpenApiDocument,
  resolveContractExpectation,
  SUPPORTED_SCHEMA_KEYWORDS,
  type OpenApiDocument,
} from './contract'
import type { ContractRef } from '../schema/service'

/**
 * M5b contract layer tests — table-driven and pure: parse, digest, resolve,
 * and the pinned-subset validator. No network, no filesystem, no git.
 */

const ref = (method: ContractRef['method'], path: string, status: number): ContractRef => ({
  file: 'openapi.yaml',
  method,
  path,
  status,
})

// ---------------------------------------------------------------------------
// parseOpenApiDocument
// ---------------------------------------------------------------------------

describe('parseOpenApiDocument', () => {
  const expectedDoc = {
    openapi: '3.0.3',
    info: { title: 'API', version: '1.0.0' },
    paths: {
      '/health': {
        get: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { type: 'string' } },
                    required: ['status'],
                  },
                },
              },
            },
          },
        },
      },
    },
  }

  const yamlText = `
openapi: 3.0.3
info: { title: API, version: 1.0.0 }
paths:
  /health:
    get:
      responses:
        200:
          content:
            application/json:
              schema:
                type: object
                properties:
                  status: { type: string }
                required: [status]
`

  const jsonText = JSON.stringify(expectedDoc)

  it('parses YAML into the document object', () => {
    expect(parseOpenApiDocument(yamlText)).toEqual(expectedDoc)
  })

  it('parses JSON into the same document object', () => {
    expect(parseOpenApiDocument(jsonText)).toEqual(expectedDoc)
  })

  it('YAML and JSON sources parse to deep-equal documents', () => {
    expect(parseOpenApiDocument(yamlText)).toEqual(parseOpenApiDocument(jsonText))
  })

  it.each([
    { name: 'null text', text: null },
    { name: 'empty text', text: '' },
    { name: 'unclosed YAML flow sequence', text: 'openapi: [unclosed' },
    { name: 'broken JSON', text: '{"broken": json' },
    { name: 'scalar-only document (number)', text: '42' },
    { name: 'scalar-only document (string)', text: 'just a scalar' },
    { name: 'array-only document', text: '- one\n- two\n' },
  ])('$name yields null', ({ text }) => {
    expect(parseOpenApiDocument(text)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// apiContractDigest
// ---------------------------------------------------------------------------

describe('apiContractDigest', () => {
  const formattedOneWay = `
openapi: 3.0.3
info: { title: API, version: 1.0.0 }
paths:
  /health:
    get:
      responses:
        200:
          content:
            application/json:
              schema:
                type: object
                properties:
                  status: { type: string }
                required: [status]
`

  /** Same semantics: reordered keys, different quoting/indent style, comments. */
  const formattedAnotherWay = `
# same document, different formatting
paths:
  /health:
    get:
      responses:
        "200":
          content:
            "application/json":
              schema:
                type: "object"
                required:
                  - status
                properties:
                  status:
                    type: "string"
info:
  version: "1.0.0"
  title: 'API'
openapi: "3.0.3"
`

  const changedOperation = `
openapi: 3.0.3
info: { title: API, version: 1.0.0 }
paths:
  /health:
    get:
      responses:
        200:
          content:
            application/json:
              schema:
                type: object
                properties:
                  status: { type: integer }
                required: [status]
`

  const parse = (text: string): OpenApiDocument => {
    const doc = parseOpenApiDocument(text)
    expect(doc).not.toBeNull()
    return doc as OpenApiDocument
  }

  it('formatting and key order never change the digest', () => {
    expect(apiContractDigest(parse(formattedOneWay))).toBe(apiContractDigest(parse(formattedAnotherWay)))
  })

  it('any semantic change to an operation diverges the digest', () => {
    expect(apiContractDigest(parse(formattedOneWay))).not.toBe(apiContractDigest(parse(changedOperation)))
  })

  it('is an oas_-prefixed sha256 hex digest', () => {
    expect(apiContractDigest(parse(formattedOneWay))).toMatch(/^oas_[0-9a-f]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// resolveContractExpectation
// ---------------------------------------------------------------------------

describe('resolveContractExpectation', () => {
  const doc = parseOpenApiDocument(`
openapi: 3.0.3
info:
  title: Tasks API
  version: 1.0.0
paths:
  /tasks:
    get:
      responses:
        '200':
          description: task list
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Task'
        '404':
          $ref: '#/components/responses/NotFound'
  /tasks/{id}:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/paths/~1tasks/get/responses/200/content/application~1json/schema'
    delete:
      responses:
        '204':
          description: deleted (status-only contract, no content)
  /plain:
    get:
      responses:
        '200':
          content:
            text/plain:
              schema: { type: string }
components:
  responses:
    NotFound:
      description: missing
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
  schemas:
    Task:
      type: object
      required: [id, title]
      properties:
        id: { type: integer }
        title: { type: string }
        owner: { $ref: '#/components/schemas/User' }
    User:
      type: object
      required: [id]
      properties:
        id: { type: integer }
        name: { type: string }
    Error:
      type: object
      required: [message]
      properties:
        message: { type: string }
`) as OpenApiDocument

  const taskArraySchema = {
    type: 'array',
    items: {
      type: 'object',
      required: ['id', 'title'],
      properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
        owner: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
          },
        },
      },
    },
  }

  const errorSchema = {
    type: 'object',
    required: ['message'],
    properties: { message: { type: 'string' } },
  }

  it.each([
    {
      name: 'inline schema resolves with status',
      contract: ref('GET', '/tasks', 200),
      expectation: { status: 200, schema: taskArraySchema },
    },
    {
      name: 'nested local $refs are eagerly inlined',
      contract: ref('GET', '/tasks/{id}', 200),
      expectation: { status: 200, schema: taskArraySchema },
    },
    {
      name: 'response-level $ref resolves to its content schema',
      contract: ref('GET', '/tasks', 404),
      expectation: { status: 404, schema: errorSchema },
    },
    {
      name: 'missing path',
      contract: ref('GET', '/nope', 200),
      reason: 'no operation GET /nope',
    },
    {
      name: 'missing method on a declared path',
      contract: ref('POST', '/tasks', 201),
      reason: 'no operation POST /tasks',
    },
    {
      name: 'missing status declaration',
      contract: ref('GET', '/tasks', 500),
      reason: 'no 500 response declared',
    },
  ])('$name', ({ contract, expectation, reason }) => {
    const result = resolveContractExpectation(doc, contract)
    if (expectation !== undefined) {
      expect(result).toEqual({ status: 'resolved', expectation })
    } else {
      expect(result).toEqual({ status: 'unresolvable', reason })
    }
  })

  it('resolves status-only when the operation declares no JSON content schema', () => {
    const result = resolveContractExpectation(doc, ref('DELETE', '/tasks/{id}', 204))
    expect(result).toEqual({ status: 'resolved', expectation: { status: 204 } })
    expect('schema' in (result as unknown as { expectation: Record<string, unknown> }).expectation).toBe(false)
  })

  it('resolves status-only when only non-JSON media types are declared', () => {
    const result = resolveContractExpectation(doc, ref('GET', '/plain', 200))
    expect(result).toEqual({ status: 'resolved', expectation: { status: 200 } })
  })

  it('the resolved schema is self-contained (no $ref keys remain)', () => {
    const result = resolveContractExpectation(doc, ref('GET', '/tasks', 200))
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') {
      return
    }
    expect(JSON.stringify(result.expectation.schema)).not.toContain('$ref')
  })

  it('an operation with no responses key at all declares no status', () => {
    const bare = parseOpenApiDocument('paths:\n  /ping:\n    get: {}\n') as OpenApiDocument
    expect(resolveContractExpectation(bare, ref('GET', '/ping', 200))).toEqual({
      status: 'unresolvable',
      reason: 'no 200 response declared',
    })
  })

  it('a document without a paths object has no operations', () => {
    const bare = parseOpenApiDocument('openapi: 3.0.3\n') as OpenApiDocument
    expect(resolveContractExpectation(bare, ref('GET', '/health', 200))).toEqual({
      status: 'unresolvable',
      reason: 'no operation GET /health',
    })
  })

  it('a non-object response declaration is unresolvable', () => {
    const malformed = parseOpenApiDocument(
      'paths:\n  /malformed:\n    get:\n      responses:\n        "200": oops\n',
    ) as OpenApiDocument
    expect(resolveContractExpectation(malformed, ref('GET', '/malformed', 200))).toEqual({
      status: 'unresolvable',
      reason: '200 response for GET /malformed is not an object',
    })
  })

  it.each([
    { name: 'URL $ref', target: 'https://example.com/schemas/Error' },
    { name: 'other-file $ref', target: './common.yaml#/Error' },
  ])('non-local $ref ($name) is unresolvable', ({ target }) => {
    const remote = parseOpenApiDocument(`
paths:
  /remote:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '${target}'
`) as OpenApiDocument
    expect(resolveContractExpectation(remote, ref('GET', '/remote', 200))).toEqual({
      status: 'unresolvable',
      reason: `non-local $ref "${target}" cannot be resolved`,
    })
  })

  it('a broken pointer (missing token) is unresolvable', () => {
    const broken = parseOpenApiDocument(`
paths:
  /missing:
    get:
      responses:
        '200':
          $ref: '#/components/responses/Gone'
components:
  responses:
    Present:
      description: not the referenced one
`) as OpenApiDocument
    const result = resolveContractExpectation(broken, ref('GET', '/missing', 200))
    expect(result.status).toBe('unresolvable')
    if (result.status === 'unresolvable') {
      expect(result.reason).toContain('$ref pointer does not resolve')
      expect(result.reason).toContain('"Gone" not found')
    }
  })

  it('a $ref cycle is unresolvable', () => {
    const cyclic = parseOpenApiDocument(`
paths:
  /loop:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/A'
components:
  schemas:
    A:
      type: object
      properties:
        b: { $ref: '#/components/schemas/B' }
    B:
      type: object
      properties:
        a: { $ref: '#/components/schemas/A' }
`) as OpenApiDocument
    const result = resolveContractExpectation(cyclic, ref('GET', '/loop', 200))
    expect(result.status).toBe('unresolvable')
    if (result.status === 'unresolvable') {
      expect(result.reason).toContain('cycle')
    }
  })

  it('reference chains deeper than 32 are unresolvable by budget', () => {
    const schemas: Record<string, unknown> = {}
    for (let index = 1; index <= 40; index++) {
      schemas[`S${index}`] =
        index < 40 ? { $ref: `#/components/schemas/S${index + 1}` } : { type: 'string' }
    }
    const deep = parseOpenApiDocument(`
paths:
  /deep:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/S1'
components:
  schemas:
`) as OpenApiDocument
    const components = { schemas }
    deep.components = components
    expect(resolveContractExpectation(deep, ref('GET', '/deep', 200))).toEqual({
      status: 'unresolvable',
      reason: '$ref depth exceeds 32',
    })
  })
})

// ---------------------------------------------------------------------------
// checkAgainstSchema
// ---------------------------------------------------------------------------

describe('checkAgainstSchema', () => {
  it.each([
    // --- type keyword ---
    { name: 'string accepts strings', value: 'hello', schema: { type: 'string' }, verdict: 'valid' },
    {
      name: 'string rejects numbers with path-bearing reason',
      value: 42,
      schema: { type: 'string' },
      verdict: 'invalid',
      reason: '(root) expected string, got number 42',
    },
    { name: 'number accepts non-integral finite numbers', value: 1.5, schema: { type: 'number' }, verdict: 'valid' },
    { name: 'number accepts integral numbers', value: 42, schema: { type: 'number' }, verdict: 'valid' },
    {
      name: 'number rejects NaN (finite only)',
      value: Number.NaN,
      schema: { type: 'number' },
      verdict: 'invalid',
      reason: '(root) expected number, got NaN',
    },
    { name: 'integer accepts integral numbers', value: 42, schema: { type: 'integer' }, verdict: 'valid' },
    { name: 'integer accepts negative integral numbers', value: -7, schema: { type: 'integer' }, verdict: 'valid' },
    {
      name: 'integer rejects non-integral numbers',
      value: 42.5,
      schema: { type: 'integer' },
      verdict: 'invalid',
      reason: '(root) expected integer, got number 42.5',
    },
    {
      name: 'integer rejects numeric strings',
      value: '42',
      schema: { type: 'integer' },
      verdict: 'invalid',
      reason: '(root) expected integer, got string "42"',
    },
    { name: 'boolean accepts booleans', value: false, schema: { type: 'boolean' }, verdict: 'valid' },
    {
      name: 'boolean rejects numbers',
      value: 1,
      schema: { type: 'boolean' },
      verdict: 'invalid',
      reason: '(root) expected boolean, got number 1',
    },
    { name: 'array accepts arrays', value: [1, 2], schema: { type: 'array' }, verdict: 'valid' },
    {
      name: 'array rejects objects',
      value: { 0: 1 },
      schema: { type: 'array' },
      verdict: 'invalid',
      reason: '(root) expected array, got object',
    },
    { name: 'object accepts objects', value: {}, schema: { type: 'object' }, verdict: 'valid' },
    {
      name: 'object rejects arrays',
      value: [],
      schema: { type: 'object' },
      verdict: 'invalid',
      reason: '(root) expected object, got array',
    },
    { name: 'null type accepts null', value: null, schema: { type: 'null' }, verdict: 'valid' },
    // --- nullable (OAS-style) ---
    {
      name: 'nullable allows null in addition to the declared type',
      value: null,
      schema: { type: 'string', nullable: true },
      verdict: 'valid',
    },
    {
      name: 'nullable still accepts the declared type',
      value: 'ok',
      schema: { type: 'string', nullable: true },
      verdict: 'valid',
    },
    {
      name: 'without nullable, null fails the typed schema',
      value: null,
      schema: { type: 'string' },
      verdict: 'invalid',
      reason: '(root) expected string, got null',
    },
    {
      name: 'nullable false is an explicit non-null',
      value: null,
      schema: { type: 'integer', nullable: false },
      verdict: 'invalid',
      reason: '(root) expected integer, got null',
    },
    {
      name: 'nullable does not widen the type for non-null values',
      value: 5,
      schema: { type: 'string', nullable: true },
      verdict: 'invalid',
      reason: '(root) expected string, got number 5',
    },
    {
      name: 'null needs an opt-in even with no type declared',
      value: null,
      schema: {},
      verdict: 'invalid',
      reason: '(root) null is not allowed (schema is not nullable)',
    },
    // --- enum (SameValueZero) ---
    { name: 'enum membership passes', value: 'red', schema: { enum: ['red', 'green'] }, verdict: 'valid' },
    {
      name: 'enum mismatch fails',
      value: 'blue',
      schema: { enum: ['red', 'green'] },
      verdict: 'invalid',
      reason: '(root) value is not in the schema enum',
    },
    { name: 'enum numbers compare exactly', value: 1, schema: { enum: [1, 2] }, verdict: 'valid' },
    {
      name: 'enum does not coerce strings to numbers',
      value: '1',
      schema: { enum: [1, 2] },
      verdict: 'invalid',
      reason: '(root) value is not in the schema enum',
    },
    { name: 'enum compares with SameValueZero (+0 equals -0)', value: -0, schema: { enum: [0] }, verdict: 'valid' },
    { name: 'enum containing null accepts null', value: null, schema: { enum: [null, 'x'] }, verdict: 'valid' },
    {
      name: 'empty enum accepts nothing',
      value: 5,
      schema: { enum: [] },
      verdict: 'invalid',
      reason: '(root) value is not in the schema enum',
    },
    // --- required ---
    {
      name: 'required all present passes',
      value: { id: 1, name: 'x' },
      schema: {
        type: 'object',
        required: ['id', 'name'],
        properties: { id: { type: 'integer' }, name: { type: 'string' } },
      },
      verdict: 'valid',
    },
    {
      name: 'missing required property is reported at the object path',
      value: { id: 1 },
      schema: {
        type: 'object',
        required: ['id', 'name'],
        properties: { id: { type: 'integer' }, name: { type: 'string' } },
      },
      verdict: 'invalid',
      reason: '(root) missing required property "name"',
    },
    {
      name: 'required is checked in declared order (first miss reported)',
      value: {},
      schema: { type: 'object', required: ['id', 'name'] },
      verdict: 'invalid',
      reason: '(root) missing required property "id"',
    },
    // --- properties ---
    {
      name: 'undeclared properties are allowed when additionalProperties is not false',
      value: { id: 1, extra: true },
      schema: { type: 'object', properties: { id: { type: 'integer' } } },
      verdict: 'valid',
    },
    {
      name: 'nested property violation names the full JSON path',
      value: { tasks: [{ id: 1 }, { id: 'x' }] },
      schema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'integer' } } },
          },
        },
      },
      verdict: 'invalid',
      reason: '.tasks[1].id expected integer, got string "x"',
    },
    // --- additionalProperties (boolean only) ---
    {
      name: 'additionalProperties true allows extra properties',
      value: { id: 1, extra: 2 },
      schema: { type: 'object', properties: { id: { type: 'integer' } }, additionalProperties: true },
      verdict: 'valid',
    },
    {
      name: 'additionalProperties false rejects the unknown property at its path',
      value: { id: 1, extra: 2 },
      schema: { type: 'object', properties: { id: { type: 'integer' } }, additionalProperties: false },
      verdict: 'invalid',
      reason: '.extra is not an allowed property (additionalProperties is false)',
    },
    // --- items ---
    { name: 'array items validated element by element', value: [1, 2, 3], schema: { type: 'array', items: { type: 'integer' } }, verdict: 'valid' },
    {
      name: 'failing element is reported at its index path',
      value: [1, 'two', 3],
      schema: { type: 'array', items: { type: 'integer' } },
      verdict: 'invalid',
      reason: '[1] expected integer, got string "two"',
    },
    // --- keyword scoping ---
    {
      name: 'object keywords do not apply to non-object values',
      value: 'scalar',
      schema: { required: ['a'], properties: { a: { type: 'string' } } },
      verdict: 'valid',
    },
    { name: 'empty schema accepts any non-null value', value: [1, 'mix'], schema: {}, verdict: 'valid' },
  ])('$name', ({ value, schema, verdict, reason }) => {
    const result = checkAgainstSchema(value, schema)
    if (verdict === 'valid') {
      expect(result).toEqual({ verdict: 'valid' })
    } else if (verdict === 'invalid') {
      expect(result).toEqual({ verdict: 'invalid', reason })
    }
  })

  describe('unsupported constructs are reported, never ignored', () => {
    it.each([
      { name: 'pattern', schema: { type: 'string', pattern: '^a' }, keyword: 'pattern' },
      { name: 'format', schema: { type: 'string', format: 'email' }, keyword: 'format' },
      { name: 'minimum', schema: { type: 'integer', minimum: 1 }, keyword: 'minimum' },
      { name: 'maximum', schema: { type: 'integer', maximum: 10 }, keyword: 'maximum' },
      { name: 'exclusiveMinimum', schema: { type: 'integer', exclusiveMinimum: 0 }, keyword: 'exclusiveMinimum' },
      { name: 'multipleOf', schema: { type: 'integer', multipleOf: 2 }, keyword: 'multipleOf' },
      { name: 'minLength', schema: { type: 'string', minLength: 1 }, keyword: 'minLength' },
      { name: 'maxLength', schema: { type: 'string', maxLength: 10 }, keyword: 'maxLength' },
      { name: 'minItems', schema: { type: 'array', minItems: 1 }, keyword: 'minItems' },
      { name: 'maxItems', schema: { type: 'array', maxItems: 5 }, keyword: 'maxItems' },
      { name: 'uniqueItems', schema: { type: 'array', uniqueItems: true }, keyword: 'uniqueItems' },
      { name: 'minProperties', schema: { type: 'object', minProperties: 1 }, keyword: 'minProperties' },
      { name: 'oneOf', schema: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, keyword: 'oneOf' },
      { name: 'allOf', schema: { allOf: [{ type: 'object' }] }, keyword: 'allOf' },
      { name: 'anyOf', schema: { anyOf: [{ type: 'string' }] }, keyword: 'anyOf' },
      { name: 'not', schema: { not: { type: 'string' } }, keyword: 'not' },
      { name: 'description (OpenAPI meta keyword is not pinned)', schema: { type: 'string', description: 'x' }, keyword: 'description' },
      { name: 'title', schema: { title: 'Task' }, keyword: 'title' },
      { name: '$defs', schema: { $defs: {} }, keyword: '$defs' },
      {
        name: 'additionalProperties as object (schema form)',
        schema: { type: 'object', additionalProperties: { type: 'string' } },
        keyword: 'additionalProperties',
      },
      { name: 'items tuple form', schema: { type: 'array', items: [{ type: 'string' }] }, keyword: 'items' },
      { name: 'unknown type token', schema: { type: 'strign' }, keyword: 'strign' },
      { name: 'type as array', schema: { type: ['string', 'null'] }, keyword: 'type' },
      { name: 'boolean schema root', schema: true, keyword: 'true' },
      { name: 'numeric schema root', schema: 42, keyword: '42' },
      {
        name: 'nested unsupported keyword inside properties',
        schema: { properties: { a: { type: 'string', minLength: 2 } } },
        keyword: 'minLength',
      },
      {
        name: 'deterministic order: keys are walked sorted (format before pattern)',
        schema: { type: 'string', pattern: 'p', format: 'f' },
        keyword: 'format',
      },
      {
        name: 'deterministic order: shallower unsupported wins over deeper',
        schema: { format: 'f', properties: { z: { pattern: 'p' } } },
        keyword: 'format',
      },
      {
        name: 'deterministic order: properties scanned in sorted name order',
        schema: { properties: { b: { pattern: 'p' }, a: { format: 'f' } } },
        keyword: 'format',
      },
    ])('$name', ({ schema, keyword }) => {
      expect(checkAgainstSchema('anything', schema)).toEqual({ verdict: 'unsupported', keyword })
    })

    it('unsupported detection wins over validity (would pass, contains format)', () => {
      expect(checkAgainstSchema('a@b.c', { type: 'string', format: 'email' })).toEqual({
        verdict: 'unsupported',
        keyword: 'format',
      })
    })

    it('unsupported detection wins over invalidity (checked before validation)', () => {
      expect(checkAgainstSchema('not-a-number', { type: 'integer', pattern: 'x' })).toEqual({
        verdict: 'unsupported',
        keyword: 'pattern',
      })
    })
  })

  it('failure reasons truncate long offending strings', () => {
    const result = checkAgainstSchema('x'.repeat(500), { type: 'integer' })
    expect(result).toMatchObject({ verdict: 'invalid' })
    if (result.verdict === 'invalid') {
      expect(result.reason).toContain('…')
      expect(result.reason.length).toBeLessThan(120)
      expect(result.reason).not.toContain('x'.repeat(50))
    }
  })

  it('is deterministic: identical inputs yield identical results', () => {
    const schema = { type: 'object', properties: { a: { type: 'array', items: { type: 'integer' } } } }
    expect(checkAgainstSchema({ a: [1, 'x'] }, schema)).toEqual(checkAgainstSchema({ a: [1, 'x'] }, schema))
  })

  it('composes with the resolver: a resolved schema validates real payloads', () => {
    const doc = parseOpenApiDocument(`
paths:
  /tasks:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Task'
components:
  schemas:
    Task:
      type: object
      required: [id, title]
      properties:
        id: { type: integer }
        title: { type: string }
`) as OpenApiDocument
    const resolution = resolveContractExpectation(doc, ref('GET', '/tasks', 200))
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') {
      return
    }
    expect(checkAgainstSchema([{ id: 1, title: 'a' }], resolution.expectation.schema)).toEqual({ verdict: 'valid' })
    expect(checkAgainstSchema([{ id: 'one', title: 'a' }], resolution.expectation.schema)).toEqual({
      verdict: 'invalid',
      reason: '[0].id expected integer, got string "one"',
    })
  })
})

// ---------------------------------------------------------------------------
// The pin list itself
// ---------------------------------------------------------------------------

describe('SUPPORTED_SCHEMA_KEYWORDS', () => {
  it('exports exactly the implemented v1 pin list', () => {
    expect(SUPPORTED_SCHEMA_KEYWORDS).toEqual([
      'type',
      'properties',
      'required',
      'items',
      'enum',
      'nullable',
      'additionalProperties',
    ])
  })

  it('is frozen (callers cannot widen the pin)', () => {
    expect(Object.isFrozen(SUPPORTED_SCHEMA_KEYWORDS)).toBe(true)
  })
})
