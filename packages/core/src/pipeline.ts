import { parse as parseYaml } from 'yaml'
import picomatch from 'picomatch'
import { enrichChangeSet } from './analyzer/change'
import { ContractValidationError, parseContract } from './schema/contract'
import { analyzeScope } from './analyzer/scope'
import { buildGraph } from './intel/graph'
import { applyPolicy } from './gate/policy'
import { renderMarkdownReport } from './report/markdown'
import type { ChangeContract, FindingClass, PolicyAction } from './schema/contract'
import { REPORT_SCHEMA_VERSION } from './schema/report'
import type { VerificationReport } from './schema/report'
import { GitAdapter } from './vcs/git'

export interface VerifyInput {
  /** Any directory inside the target repository. */
  repo: string
  before: string
  after: string
  /** Parsed contract, or raw YAML text. */
  contract: ChangeContract | string
}

function parseContractYaml(text: string): unknown {
  try {
    return parseYaml(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ContractValidationError(`Invalid change contract (YAML syntax): ${detail}`, [])
  }
}

export interface VerifyOutput extends VerificationReport {
  markdown: string
  json: string
}

/**
 * Full M1 pipeline:
 *   contract → git diff → enrichment → intelligence graph → scope analysis →
 *   integrity gate → evidence-backed report.
 */
export async function verifyChange(input: VerifyInput): Promise<VerifyOutput> {
  const contract =
    typeof input.contract === 'string' ? parseContract(parseContractYaml(input.contract)) : input.contract

  const git = await GitAdapter.open(input.repo)
  const changeSet = await git.diffRefs(input.before, input.after)
  const [enriched, graph] = await Promise.all([
    enrichChangeSet(git, changeSet),
    buildGraph(git, input.after),
  ])

  const { assessment, findings } = analyzeScope(contract, enriched, graph)
  const gate = applyPolicy(findings, contract.policy as Partial<Record<FindingClass, PolicyAction>>)

  const mustChangeGlobs = contract.paths.mustChange.filter(
    (rule): rule is string => typeof rule === 'string',
  )
  const touchedGlobs = mustChangeGlobs.filter((glob) =>
    enriched.records.some((record) =>
      (record.oldPath ? [record.path, record.oldPath] : [record.path]).some((path) =>
        pathMatchesGlob(path, glob),
      ),
    ),
  )
  const accomplished: VerificationReport['threeQuestions']['accomplished'] =
    mustChangeGlobs.length === 0
      ? 'unknown'
      : touchedGlobs.length === mustChangeGlobs.length
        ? 'yes'
        : touchedGlobs.length === 0
          ? 'no'
          : 'partial'

  const withinScope = findings.some((finding) =>
    ['prohibited-change', 'preserved-area-changed', 'out-of-scope-change'].includes(finding.findingClass),
  )
    ? 'no'
    : 'yes'

  const count = (classification: string) =>
    assessment.perPath.filter((item) => item.classification === classification).length

  const report: VerificationReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    contractId: contract.id,
    goal: contract.goal,
    repoRoot: git.repoRoot,
    before: input.before,
    after: input.after,
    beforeSha: changeSet.beforeSha,
    afterSha: changeSet.afterSha,
    threeQuestions: { accomplished, withinScope, regressions: { status: 'not-verified' } },
    verdict: gate.verdict,
    triggeredActions: gate.triggeredActions,
    perPath: assessment.perPath,
    findings: gate.findings,
    statistics: {
      filesChanged: assessment.perPath.length,
      expected: count('EXPECTED'),
      related: count('RELATED'),
      suspicious: count('SUSPICIOUS'),
      outOfScope: count('OUT_OF_SCOPE'),
      prohibited: count('PROHIBITED'),
      findings: findings.length,
    },
  }

  return { ...report, markdown: renderMarkdownReport(report), json: JSON.stringify(report, null, 2) }
}

function pathMatchesGlob(path: string, glob: string): boolean {
  return picomatch.isMatch(path, glob, { dot: true })
}
