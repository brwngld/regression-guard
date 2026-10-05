import { execFile, spawn } from 'node:child_process'

/**
 * Bounded command execution for the Baseline Engine.
 *
 * Test runners hang; servers stay alive; child processes spawn children.
 * Every execution therefore has:
 *   - a hard timeout with process-TREE kill (taskkill /T on Windows, process
 *     group kill on POSIX), not just the shell pid;
 *   - output caps (head + tail) so hostile runners cannot exhaust memory;
 *   - a resolution guarantee: runCommand never rejects and never hangs past
 *     its timeout window.
 */

const HEAD_LIMIT = 64 * 1024
const TAIL_LIMIT = 16 * 1024

export interface RunOutcome {
  command: string
  cwd: string
  exitCode: number | null
  timedOut: boolean
  spawnError: string | null
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

/** Captures head + tail of an unbounded stream with a truncation marker. */
class CappedBuffer {
  private head = ''
  private tail = ''
  private overflow = 0
  private seen = 0

  append(chunk: string): void {
    this.seen += chunk.length
    const room = HEAD_LIMIT - this.head.length
    if (room > 0) {
      this.head += chunk.slice(0, room)
      chunk = chunk.slice(room)
    }
    if (chunk.length > 0) {
      this.tail = (this.tail + chunk).slice(-TAIL_LIMIT)
      this.overflow += 1
    }
  }

  get truncated(): boolean {
    return this.seen > HEAD_LIMIT
  }

  text(): string {
    if (!this.truncated) {
      return this.head
    }
    const omitted = this.seen - this.head.length - this.tail.length
    return `${this.head}\n[... ${omitted} bytes omitted ...]\n${this.tail}`
  }
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) {
    return
  }
  if (process.platform === 'win32') {
    // /T kills the entire descendant tree, /F forces stubborn children.
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
    return
  }
  try {
    // The child was spawned detached, making it a process-group leader;
    // killing the negative pid reaps the whole group.
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

export function runCommand(
  command: string,
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<RunOutcome> {
  const isWindows = process.platform === 'win32'

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const stdout = new CappedBuffer()
    const stderr = new CappedBuffer()

    let timedOut = false
    let settled = false

    // Single-string shell invocation (never spawn(shell, [argv..., command])):
    // passing the command as one escaped argv element mangles embedded double
    // quotes through cmd.exe on Windows — quoted arguments such as
    // `-t "test name"` would arrive WITH literal quote characters and break
    // argument parsing. The shell:true path wraps the string the same way
    // child_process.exec does, which preserves quoted arguments exactly.
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: !isWindows,
      windowsHide: true,
      env: { ...process.env, ...(options.env ?? {}), NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const finish = (exitCode: number | null, spawnError: string | null = null) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeoutHandle)
      clearTimeout(lastChanceHandle)
      resolve({
        command,
        cwd: options.cwd,
        exitCode,
        timedOut,
        spawnError,
        durationMs: Date.now() - startedAt,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      })
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
      // Resolution guarantee: if the tree refuses to die, report anyway.
      lastChanceHandle = setTimeout(() => finish(null, 'process did not exit after kill'), 8_000)
    }, options.timeoutMs)

    let lastChanceHandle: NodeJS.Timeout | undefined

    child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk.toString('utf8')))

    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code))
  })
}
