import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChangeRecord } from '../schema/changeset'
import type { GitAdapter } from './git'
import { fingerprintRecords, workingTreeFingerprint } from './fingerprint'
import type { FingerprintRecord } from './fingerprint'

const sha256Hex = (input: string): string => createHash('sha256').update(input).digest('hex')

function changeRecord(
  overrides: Partial<ChangeRecord> & Pick<ChangeRecord, 'path' | 'status'>,
): ChangeRecord {
  return {
    binary: false,
    hunks: [],
    addedLines: 0,
    removedLines: 0,
    categories: [],
    ...overrides,
  }
}

describe('fingerprintRecords', () => {
  const records: FingerprintRecord[] = [
    { path: 'src/kept.txt', status: 'modified', content: 'kept content\n' },
    { path: 'src/moved.txt', status: 'renamed', oldPath: 'src/old.txt', content: 'moved content' },
    { path: 'src/gone.txt', status: 'deleted', content: null },
  ]

  it('is deterministic across repeated calls', () => {
    const first = fingerprintRecords(records)
    expect(fingerprintRecords(records)).toBe(first)
    // Fresh object identities with identical values must not matter either.
    expect(fingerprintRecords(records.map((record) => ({ ...record })))).toBe(first)
  })

  it('is insensitive to input order', () => {
    const expected = fingerprintRecords(records)
    const shuffled = [records[2]!, records[0]!, records[1]!]
    expect(fingerprintRecords(shuffled)).toBe(expected)
  })

  it('changes when a single character of content changes', () => {
    const base = [{ path: 'src/a.txt', status: 'modified', content: 'same content' }]
    const tweaked = [{ path: 'src/a.txt', status: 'modified', content: 'same contents' }]
    expect(fingerprintRecords(tweaked)).not.toBe(fingerprintRecords(base))
  })

  it('changes when only the status differs', () => {
    const asCreated = [{ path: 'src/a.txt', status: 'created', content: 'payload' }]
    const asModified = [{ path: 'src/a.txt', status: 'modified', content: 'payload' }]
    expect(fingerprintRecords(asCreated)).not.toBe(fingerprintRecords(asModified))
  })

  it('renders absent content as "(absent)" deterministically', () => {
    const deleted = [{ path: 'src/gone.txt', status: 'deleted', content: null }]
    const expected = `sha256:${sha256Hex('deleted src/gone.txt (absent)')}`
    expect(fingerprintRecords(deleted)).toBe(expected)
    expect(fingerprintRecords(deleted)).toBe(fingerprintRecords(deleted))
  })

  it('distinguishes absent content from present (even empty) content', () => {
    const absent = [{ path: 'src/x.txt', status: 'deleted', content: null }]
    const present = [{ path: 'src/x.txt', status: 'deleted', content: '' }]
    expect(fingerprintRecords(absent)).not.toBe(fingerprintRecords(present))
  })

  it('includes oldPath in the canonical line for renames', () => {
    const fromA = [{ path: 'src/new.txt', status: 'renamed', oldPath: 'src/a.txt', content: 'payload' }]
    const fromB = [{ path: 'src/new.txt', status: 'renamed', oldPath: 'src/b.txt', content: 'payload' }]
    expect(fingerprintRecords(fromA)).not.toBe(fingerprintRecords(fromB))
  })

  it('hashes the path-sorted, newline-joined canonical lines', () => {
    const expected = `sha256:${sha256Hex(
      [
        'deleted src/gone.txt (absent)',
        `modified src/kept.txt ${sha256Hex('kept content\n')}`,
        `renamed src/moved.txt <- src/old.txt ${sha256Hex('moved content')}`,
      ].join('\n'),
    )}`
    // Reversed input must still land on the same canonical ordering.
    expect(fingerprintRecords([...records].reverse())).toBe(expected)
  })

  it('returns "sha256:" followed by 64 lowercase hex characters', () => {
    expect(fingerprintRecords(records)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('workingTreeFingerprint', () => {
  let root: string

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true })
      root = undefined as unknown as string
    }
  })

  it('reads working-tree contents and treats unreadable paths as absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'regression-guard-fp-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'kept.txt'), 'kept content\n', 'utf8')

    const git = { repoRoot: root } as unknown as GitAdapter
    const records = [
      changeRecord({ path: 'src/kept.txt', status: 'modified' }),
      changeRecord({ path: 'src/gone.txt', status: 'deleted' }),
    ]

    const expected = fingerprintRecords([
      { path: 'src/kept.txt', status: 'modified', content: 'kept content\n' },
      { path: 'src/gone.txt', status: 'deleted', content: null },
    ])
    await expect(workingTreeFingerprint(git, records)).resolves.toBe(expected)
  })
})
