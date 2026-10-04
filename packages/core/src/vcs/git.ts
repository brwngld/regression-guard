import type { ChangeSet, ChangeRecord } from '../schema/changeset'
import { runGit } from './exec'
import { parseNameStatus, parseUnifiedDiff } from './parse'

/**
 * Read-only git adapter. All paths are repo-root relative with forward
 * slashes, regardless of host platform.
 */
export class GitAdapter {
  private constructor(readonly repoRoot: string) {}

  /** Resolve the repository root containing `cwd`. */
  static async open(cwd: string): Promise<GitAdapter> {
    const root = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim()
    if (!root) {
      throw new Error(`Not inside a git repository: ${cwd}`)
    }
    return new GitAdapter(root.replace(/\\/g, '/'))
  }

  async revParse(ref: string): Promise<string> {
    const sha = (await runGit(this.repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      throw new Error(`Could not resolve git ref: ${ref}`)
    }
    return sha
  }

  /** Build the ChangeSet between two refs (statuses + rename detection, then hunks). */
  async diffRefs(before: string, after: string): Promise<ChangeSet> {
    const [beforeSha, afterSha] = await Promise.all([this.revParse(before), this.revParse(after)])

    const nameStatus = await runGit(this.repoRoot, [
      'diff',
      '--name-status',
      '-M',
      '-z',
      before,
      after,
    ])
    const unified = await runGit(this.repoRoot, [
      'diff',
      '--unified=0',
      '-M',
      before,
      after,
    ])

    const entries = parseNameStatus(nameStatus)
    const sections = parseUnifiedDiff(unified)
    const sectionsByPath = new Map(sections.map((section) => [section.path, section]))

    const records: ChangeRecord[] = entries.map((entry) => {
      const section = sectionsByPath.get(entry.path)
      return {
        path: entry.path,
        oldPath: entry.oldPath,
        status: entry.status,
        binary: section?.binary ?? false,
        hunks: section?.hunks ?? [],
        addedLines: section ? (section.binary ? -1 : section.addedLines) : 0,
        removedLines: section ? (section.binary ? -1 : section.removedLines) : 0,
        categories: [],
      }
    })

    // Defensive: keep unified sections that name-status somehow missed
    // (e.g. submodule transitions), inferring their status from headers.
    const known = new Set(records.map((record) => record.path))
    for (const section of sections) {
      if (known.has(section.path)) {
        continue
      }
      records.push({
        path: section.path,
        oldPath: section.oldPath,
        status: section.newFile ? 'created' : section.deletedFile ? 'deleted' : 'modified',
        binary: section.binary,
        hunks: section.hunks,
        addedLines: section.binary ? -1 : section.addedLines,
        removedLines: section.binary ? -1 : section.removedLines,
        categories: [],
      })
    }

    records.sort((left, right) => left.path.localeCompare(right.path))
    return { before, after, beforeSha, afterSha, records }
  }

  /** All tracked file paths at a ref. */
  async listFiles(ref: string): Promise<string[]> {
    const output = await runGit(this.repoRoot, ['ls-tree', '-r', '--name-only', '-z', ref])
    return output.split('\0').filter((path) => path.length > 0)
  }

  /** File content at a ref, or null when the path does not exist there. */
  async readFileAt(ref: string, path: string): Promise<string | null> {
    try {
      return await runGit(this.repoRoot, ['show', `${ref}:${path}`])
    } catch {
      return null
    }
  }

  /** Untracked, non-ignored file paths in the working tree. */
  async listUntracked(): Promise<string[]> {
    const output = await runGit(this.repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
    return output.split('\0').filter((path) => path.length > 0)
  }

  /**
   * ChangeSet between a ref and the current working tree (staged + unstaged
   * tracked changes plus untracked files). Never mutates anything.
   */
  async diffWorkingTree(before: string): Promise<ChangeSet> {
    const [beforeSha, headSha] = await Promise.all([this.revParse(before), this.revParse('HEAD')])
    const nameStatus = await runGit(this.repoRoot, ['diff', '--name-status', '-M', '-z', before])
    const records: ChangeRecord[] = parseNameStatus(nameStatus).map((entry) => ({
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      binary: false,
      hunks: [],
      addedLines: 0,
      removedLines: 0,
      categories: [],
    }))

    const known = new Set(records.map((record) => record.path))
    for (const path of await this.listUntracked()) {
      if (known.has(path)) {
        continue
      }
      records.push({
        path,
        status: 'created',
        binary: false,
        hunks: [],
        addedLines: 0,
        removedLines: 0,
        categories: [],
      })
    }

    records.sort((left, right) => left.path.localeCompare(right.path))
    return { before, after: 'working-tree', beforeSha, afterSha: headSha, records }
  }

  /**
   * Materialize a ref into an isolated worktree at `dir` without touching the
   * current checkout. The caller owns cleanup via removeWorktree().
   */
  async createWorktree(dir: string, ref: string): Promise<void> {
    await runGit(this.repoRoot, ['worktree', 'add', '--detach', '--force', dir, ref])
  }

  async removeWorktree(dir: string): Promise<void> {
    try {
      await runGit(this.repoRoot, ['worktree', 'remove', '--force', dir])
    } catch {
      try {
        await runGit(this.repoRoot, ['worktree', 'prune'])
      } catch {
        // Best effort; the temp directory removal below is the safety net.
      }
    }
  }
}
