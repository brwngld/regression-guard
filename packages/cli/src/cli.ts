#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Command } from 'commander'
import pc from 'picocolors'
import { verifyChange, type Verdict } from '@regression-guard/core'

const VERDICT_COLOR: Record<Verdict, (text: string) => string> = {
  ACCEPT: pc.green,
  WARN: pc.yellow,
  REVIEW: pc.magenta,
  REJECT: pc.red,
}

const CONTRACT_TEMPLATE = `# Regression Guard change contract.
# The verifier checks every change between two refs against this file.
# Docs: docs/architecture.md
version: 1
id: my-change
goal: Describe the intended outcome of this change in one sentence.

paths:
  # Areas the change is expected to touch (repo-root globs).
  mustChange: []
    # - "src/pages/Home.tsx"
  # Areas the change may touch if needed.
  mayChange: []
    # - "src/styles/**"
  # Areas that must not change. Violations default to REJECT.
  mustPreserve: []
    # - "src/auth/**"
  # Hard prohibitions: globs or sensitive categories
  # (schema-migration, database-schema, env-secrets, lockfile, ci-config,
  #  dependency-addition, dependency-removal).
  prohibited: []
    # - category: dependency-addition

# Optional policy overrides per finding class:
# (prohibited-change, preserved-area-changed, out-of-scope-change,
#  new-dependency, removed-dependency, changed-dependency, deleted-test,
#  sensitive-file-changed, unfulfilled-contract, test-command-changed)
# policy:
#   out-of-scope-change: warn

acceptance: []
  # - id: AC-1
  #   description: The homepage renders the new design.
`

class SilentExit extends Error {}

const program = new Command()
program
  .name('regression-guard')
  .description('Verify a change against its contract — verify the change, not the author.')
  .version('0.1.0')
  .exitOverride((error) => {
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
      throw new SilentExit()
    }
    throw error
  })

program
  .command('verify')
  .description('Verify the change between two git refs (or the uncommitted working tree) against a change contract')
  .requiredOption('--contract <path>', 'path to a YAML change contract')
  .requiredOption('--before <ref>', 'git ref of the base state (branch, tag, or SHA)')
  .option('--after <ref>', 'git ref of the changed state (required unless --working-tree)')
  .option('--working-tree', 'verify uncommitted changes on top of --before, without committing')
  .option('--skip-tests', 'skip regression verification (regressions stay not-verified)')
  .option('--skip-reproduction', 'skip N-of-M reproduction of findings')
  .option('--test-timeout <ms>', 'per-run timeout for test execution', '300000')
  .option('--cwd <dir>', 'repository (or any directory inside it)', process.cwd())
  .option('--format <kind>', 'report format: markdown or json', 'markdown')
  .option('--out <file>', 'write the report to a file instead of stdout')
  .action(
    async (options: {
      contract: string
      before: string
      after?: string
      workingTree?: boolean
      skipTests?: boolean
      skipReproduction?: boolean
      testTimeout: string
      cwd: string
      format: string
      out?: string
    }) => {
      if (options.format !== 'markdown' && options.format !== 'json') {
        program.error(`--format must be markdown or json (got ${options.format})`)
      }
      if (options.workingTree && options.after) {
        program.error('--working-tree verifies uncommitted changes; do not also pass --after')
      }
      if (!options.workingTree && !options.after) {
        program.error('--after is required (or use --working-tree for uncommitted changes)')
      }
      const testTimeoutMs = Number(options.testTimeout)
      if (!Number.isFinite(testTimeoutMs) || testTimeoutMs <= 0) {
        program.error(`--test-timeout must be a positive number of milliseconds (got ${options.testTimeout})`)
      }

      let contractText: string
      try {
        // Relative --contract resolves against the process cwd first, then
        // falls back to the repository root (--cwd): contracts live in the
        // repo they govern, but the CLI is often invoked from elsewhere.
        const primary = path.resolve(options.contract)
        const contractPath =
          existsSync(primary) || path.isAbsolute(options.contract)
            ? primary
            : path.resolve(options.cwd, options.contract)
        contractText = await readFile(contractPath, 'utf8')
      } catch (cause) {
        program.error(`Cannot read contract file: ${options.contract}`)
        throw cause
      }

      const report = await verifyChange({
        repo: path.resolve(options.cwd),
        before: options.before,
        after: options.workingTree ? undefined : options.after,
        mode: options.workingTree ? 'working-tree' : 'refs',
        runTests: !options.skipTests,
        reproduction: options.skipReproduction ? false : undefined,
        testTimeoutMs,
        contract: contractText,
      })

      const body = options.format === 'json' ? report.json : report.markdown
      if (options.out) {
        await writeFile(path.resolve(options.out), `${body}\n`, 'utf8')
      } else {
        process.stdout.write(`${body}\n`)
      }

      const regressions = report.threeQuestions.regressions
      const verdictLine = `regression-guard: ${report.verdict} — accomplished: ${report.threeQuestions.accomplished}, in-scope: ${report.threeQuestions.withinScope}, regressions: ${regressions.status}${regressions.regressionsFound ? ` (${regressions.regressionsFound})` : ''}`
      process.stderr.write(`${VERDICT_COLOR[report.verdict](verdictLine)}\n`)

      process.exitCode = report.verdict === 'ACCEPT' || report.verdict === 'WARN' ? 0 : 1
    },
  )

program
  .command('init')
  .description('Scaffold a regression-guard.contract.yaml in the current directory')
  .option('--cwd <dir>', 'target directory', process.cwd())
  .option('--force', 'overwrite an existing contract file')
  .action(async (options: { cwd: string; force?: boolean }) => {
    const target = path.join(path.resolve(options.cwd), 'regression-guard.contract.yaml')
    if (existsSync(target) && !options.force) {
      program.error(`${target} already exists (use --force to overwrite)`)
    }
    await writeFile(target, CONTRACT_TEMPLATE, 'utf8')
    process.stdout.write(`Wrote ${target}\n`)
  })

async function main() {
  try {
    await program.parseAsync(process.argv)
  } catch (error) {
    if (error instanceof SilentExit) {
      return
    }
    // Commander errors have already printed their message.
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.startsWith('commander.')) {
      process.exitCode = 2
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(pc.red(`regression-guard: ${message}\n`))
    process.exitCode = 2
  }
}

void main()
