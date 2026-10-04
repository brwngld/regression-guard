import type { ChangeStatus, HunkSummary } from '../schema/changeset'

/**
 * Pure parsers for `git diff` output. Kept free of process concerns so they can
 * be unit-tested against recorded fixture output.
 *
 * Formats (verified against git 2.53):
 *   git diff --name-status -M -z BEFORE AFTER
 *     -> NUL-separated tokens: `M\0path\0`, `A\0path\0`, `D\0path\0`,
 *        `R100\0old\0new\0` (old first, new second for renames/copies).
 *   git diff --unified=0 -M BEFORE AFTER
 *     -> unified diff; hunk headers may carry a trailing context anchor
 *        (`@@ -1,0 +2 @@ x`), and binary files emit
 *        `Binary files a/x and b/x differ` with no hunks.
 *
 * Note: renames with heavy content edits are frequently NOT detected as
 * renames by git and surface as separate delete + add records. That is
 * acceptable — classification assesses both paths independently.
 */

export interface RawStatusEntry {
  status: ChangeStatus
  path: string
  oldPath?: string
}

const SIMPLE_STATUS: Record<string, ChangeStatus> = {
  M: 'modified',
  T: 'modified',
  A: 'created',
  D: 'deleted',
}

export function parseNameStatus(output: string): RawStatusEntry[] {
  const tokens = output.split('\0').filter((token) => token.length > 0)
  const entries: RawStatusEntry[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (!token) {
      index += 1
      continue
    }
    const status = token.replace(/\d+$/, '')
    if (status === 'R' || status === 'C') {
      const oldPath = tokens[index + 1]
      const newPath = tokens[index + 2]
      if (oldPath && newPath) {
        entries.push({ status: 'renamed', path: newPath, oldPath })
        index += 3
        continue
      }
    }
    const mapped = SIMPLE_STATUS[status]
    const path = tokens[index + 1]
    if (mapped && path) {
      entries.push({ status: mapped, path })
      index += 2
      continue
    }
    // Unknown or merge-conflict statuses: skip the token rather than fail.
    index += 1
  }
  return entries
}

export interface UnifiedSection {
  path: string
  oldPath?: string
  newFile: boolean
  deletedFile: boolean
  binary: boolean
  hunks: HunkSummary[]
  addedLines: number
  removedLines: number
}

function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Extract (aPath, bPath) from a `diff --git a/X b/Y` header. Paths containing
 * the literal ` b/` sequence are an accepted M1 limitation.
 */
function parseDiffGitLine(line: string): { aPath?: string; bPath?: string } {
  const body = line.slice('diff --git '.length)
  const marker = body.indexOf(' b/')
  if (marker === -1) {
    const single = stripQuotes(body.replace(/^a\//, ''))
    return { aPath: single }
  }
  const aPath = stripQuotes(body.slice(0, marker).replace(/^a\//, ''))
  const bPath = stripQuotes(body.slice(marker + 3))
  return { aPath, bPath }
}

function parseHunkHeader(line: string): HunkSummary | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
  if (!match) {
    return null
  }
  return {
    beforeStart: Number(match[1]),
    beforeCount: match[2] === undefined ? 1 : Number(match[2]),
    afterStart: Number(match[3]),
    afterCount: match[4] === undefined ? 1 : Number(match[4]),
    added: 0,
    removed: 0,
  }
}

export function parseUnifiedDiff(output: string): UnifiedSection[] {
  const sections: UnifiedSection[] = []
  let current: UnifiedSection | null = null

  for (const rawLine of output.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (line.startsWith('diff --git ')) {
      if (current) {
        sections.push(current)
      }
      const { aPath, bPath } = parseDiffGitLine(line)
      current = {
        path: bPath ?? aPath ?? '',
        oldPath: aPath && bPath && aPath !== bPath ? aPath : undefined,
        newFile: false,
        deletedFile: false,
        binary: false,
        hunks: [],
        addedLines: 0,
        removedLines: 0,
      }
      continue
    }

    if (!current) {
      continue
    }

    if (line.startsWith('new file mode')) {
      current.newFile = true
      continue
    }
    if (line.startsWith('deleted file mode')) {
      current.deletedFile = true
      continue
    }
    if (line.startsWith('Binary files ')) {
      current.binary = true
      continue
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = stripQuotes(line.slice('rename from '.length))
      continue
    }
    if (line.startsWith('rename to ')) {
      current.path = stripQuotes(line.slice('rename to '.length))
      continue
    }

    if (line.startsWith('@@')) {
      const hunk = parseHunkHeader(line)
      if (hunk) {
        current.hunks.push(hunk)
      }
      continue
    }

    const lastHunk = current.hunks[current.hunks.length - 1]
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.addedLines += 1
      if (lastHunk) {
        lastHunk.added += 1
      }
      continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.removedLines += 1
      if (lastHunk) {
        lastHunk.removed += 1
      }
    }
  }

  if (current) {
    sections.push(current)
  }
  return sections
}
