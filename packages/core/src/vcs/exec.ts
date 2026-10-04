import { execFile } from 'node:child_process'

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export function runGit(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message).trim()
          reject(new GitError(`git ${args.join(' ')} failed: ${detail}`, String(stderr ?? '')))
          return
        }
        // Normalize Windows CRLF so structural parsing is consistent.
        resolve(String(stdout).replace(/\r\n/g, '\n'))
      },
    )
  })
}
