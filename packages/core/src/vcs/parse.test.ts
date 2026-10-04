import { describe, expect, it } from 'vitest'
import { parseNameStatus, parseUnifiedDiff } from './parse'

// Fixtures below are recorded verbatim from git 2.53 output against a scratch
// repository containing a modify, create, delete, pure rename (R100), a
// rename-with-edit (reported as D+A — not detected as a rename), and a binary
// change. If git's formats ever shift, regenerate rather than hand-edit.

const NAME_STATUS_Z = [
  'M\0src/bin.dat\0',
  'A\0src/created.txt\0',
  'D\0src/del.txt\0',
  'M\0src/mod.txt\0',
  'R100\0src/pure.txt\0src/puremoved.txt\0',
  'D\0src/ren.txt\0',
  'A\0src/renamed.txt\0',
].join('')

const UNIFIED_U0 = `diff --git a/src/bin.dat b/src/bin.dat
index 8352675..a903574 100644
Binary files a/src/bin.dat and b/src/bin.dat differ
diff --git a/src/created.txt b/src/created.txt
new file mode 100644
index 0000000..fa49b07
--- /dev/null
+++ b/src/created.txt
@@ -0,0 +1 @@
+new file
diff --git a/src/del.txt b/src/del.txt
deleted file mode 100644
index 975fbec..0000000
--- a/src/del.txt
+++ /dev/null
@@ -1 +0,0 @@
-y
diff --git a/src/mod.txt b/src/mod.txt
index 587be6b..aabe7c1
--- a/src/mod.txt
+++ b/src/mod.txt
@@ -1,0 +2 @@ x
+CHANGED
diff --git a/src/pure.txt b/src/puremoved.txt
similarity index 100%
rename from src/pure.txt
rename to src/puremoved.txt
diff --git a/src/ren.txt b/src/ren.txt
deleted file mode 100644
index b680253..0000000
--- a/src/ren.txt
+++ /dev/null
@@ -1 +0,0 @@
-z
diff --git a/src/renamed.txt b/src/renamed.txt
new file mode 100644
index 0000000..32df4a8
--- /dev/null
+++ b/src/renamed.txt
@@ -0,0 +1,2 @@
+z
+more
`

describe('parseNameStatus', () => {
  it('parses simple statuses and renames from NUL-separated output', () => {
    const entries = parseNameStatus(NAME_STATUS_Z)
    expect(entries).toEqual([
      { status: 'modified', path: 'src/bin.dat' },
      { status: 'created', path: 'src/created.txt' },
      { status: 'deleted', path: 'src/del.txt' },
      { status: 'modified', path: 'src/mod.txt' },
      { status: 'renamed', path: 'src/puremoved.txt', oldPath: 'src/pure.txt' },
      { status: 'deleted', path: 'src/ren.txt' },
      { status: 'created', path: 'src/renamed.txt' },
    ])
  })

  it('returns empty for empty output', () => {
    expect(parseNameStatus('')).toEqual([])
  })
})

describe('parseUnifiedDiff', () => {
  const sections = parseUnifiedDiff(UNIFIED_U0)
  const byPath = new Map(sections.map((section) => [section.path, section]))

  it('collects sections for every changed file, keyed by canonical path', () => {
    expect([...byPath.keys()].sort()).toEqual([
      'src/bin.dat',
      'src/created.txt',
      'src/del.txt',
      'src/mod.txt',
      'src/puremoved.txt',
      'src/ren.txt',
      'src/renamed.txt',
    ])
  })

  it('marks binary files and omits hunks', () => {
    const binary = byPath.get('src/bin.dat')
    expect(binary?.binary).toBe(true)
    expect(binary?.hunks).toEqual([])
    expect(binary?.addedLines).toBe(0)
    expect(binary?.removedLines).toBe(0)
  })

  it('parses hunk headers with and without counts, ignoring trailing anchors', () => {
    const mod = byPath.get('src/mod.txt')
    // `@@ -1,0 +2 @@ x` — trailing anchor ' x' must be ignored.
    expect(mod?.hunks).toEqual([
      { beforeStart: 1, beforeCount: 0, afterStart: 2, afterCount: 1, added: 1, removed: 0 },
    ])
    expect(mod?.addedLines).toBe(1)
    expect(mod?.removedLines).toBe(0)
  })

  it('counts added and removed lines across hunks', () => {
    const created = byPath.get('src/renamed.txt')
    expect(created?.addedLines).toBe(2)
    expect(created?.removedLines).toBe(0)
    expect(created?.newFile).toBe(true)
  })

  it('records deleted-file sections and their removed lines', () => {
    const deleted = byPath.get('src/del.txt')
    expect(deleted?.deletedFile).toBe(true)
    expect(deleted?.removedLines).toBe(1)
  })

  it('uses rename from/to lines for the canonical path', () => {
    const renamed = byPath.get('src/puremoved.txt')
    expect(renamed?.oldPath).toBe('src/pure.txt')
    expect(renamed?.hunks).toEqual([])
  })

  it('handles empty output', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })
})
