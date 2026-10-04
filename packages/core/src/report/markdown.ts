import type { VerificationReport } from '../schema/report'

function classificationMark(classification: string): string {
  switch (classification) {
    case 'EXPECTED':
      return 'EXPECTED '
    case 'RELATED':
      return 'RELATED   '
    case 'SUSPICIOUS':
      return 'SUSPICIOUS'
    case 'PROHIBITED':
      return 'PROHIBITED'
    default:
      return 'OUT_OF_SCO'
  }
}

function severityMark(severity: string): string {
  switch (severity) {
    case 'critical':
      return '[!] CRITICAL'
    case 'warn':
      return '[~] WARN'
    default:
      return '[i] INFO'
  }
}

function regressionsLine(status: VerificationReport['threeQuestions']['regressions']): string {
  switch (status.status) {
    case 'not-verified':
      return 'NOT VERIFIED — requires the Baseline Engine (milestone 2)'
    case 'pass':
      return `PASS — ${status.baselineTests ?? 0} baseline tests compared`
    case 'fail':
      return `FAIL — ${status.regressionsFound ?? 0} regression(s) of ${status.baselineTests ?? 0} baseline tests`
    case 'partial':
      return `PARTIAL — baseline incomplete (${status.regressionsFound ?? 0} regression(s) found)`
  }
}

export function renderMarkdownReport(report: VerificationReport): string {
  const lines: string[] = []
  const push = (...text: string[]) => lines.push(...text)

  // Working-tree mode compares HEAD plus a dirty overlay: no after SHA exists,
  // so the deterministic state fingerprint identifies what was verified.
  const compared =
    report.workingTree !== undefined
      ? `\`${report.before}\` (${report.beforeSha.slice(0, 10)}) → working-tree (base ${report.workingTree.baseSha.slice(0, 10)}, ${report.workingTree.fingerprint.slice(0, 19)}…)`
      : `\`${report.before}\` (${report.beforeSha.slice(0, 10)}) → \`${report.after}\` (${report.afterSha === null ? '' : report.afterSha.slice(0, 10)})`

  push('# Change Integrity Report', '')
  push(`- **Contract:** ${report.contractId} — ${report.goal}`)
  push(`- **Compared:** ${compared}`)
  push(`- **Generated:** ${report.generatedAt}`)
  push('', '---', '')
  push(`## Verdict: ${report.verdict}`, '')

  push('### The three questions', '')
  push(`1. **Requested change accomplished?** ${report.threeQuestions.accomplished}`)
  push(`2. **Within permitted scope?** ${report.threeQuestions.withinScope}`)
  push(`3. **No regressions introduced?** ${regressionsLine(report.threeQuestions.regressions)}`)
  push('')

  push('### Scope assessment ("should this have changed?")', '')
  if (report.perPath.length === 0) {
    push('_No files changed between the compared refs._', '')
  } else {
    push('```')
    for (const item of report.perPath) {
      push(`${classificationMark(item.classification)}  ${item.status.padEnd(8)} ${item.path}`)
      push(`${' '.repeat(13)}reason: ${item.reason}`)
    }
    push('```', '')
  }

  const counts = report.statistics
  push(
    `Files changed: ${counts.filesChanged} — expected ${counts.expected}, related ${counts.related}, suspicious ${counts.suspicious}, out-of-scope ${counts.outOfScope}, prohibited ${counts.prohibited}.`,
    '',
  )

  if (report.baseline) {
    const b = report.baseline
    push('### Regression verification (baseline engine)', '')
    push(`- **Test command:** \`${b.userCommand}\`${b.perTest ? '' : ' (suite-level outcomes — runner did not provide individual test results)'}`)
    push(`- **Before:** \`${b.before.ref}\` (${b.before.sha.slice(0, 10)}) — exit ${b.before.exitCode ?? 'n/a'}, ${Math.round(b.before.durationMs / 100) / 10}s, ${b.before.tests.length} test(s)`)
    const afterIdentity =
      b.after.fingerprint !== undefined
        ? `${b.after.sha.slice(0, 10)}, ${b.after.fingerprint.slice(0, 19)}…`
        : b.after.sha.slice(0, 10)
    push(`- **After:** \`${b.after.ref}\` (${afterIdentity}) — exit ${b.after.exitCode ?? 'n/a'}, ${Math.round(b.after.durationMs / 100) / 10}s, ${b.after.tests.length} test(s)`)
    const s = b.summary
    push(`- **Transitions:** ${s.preserved} preserved, **${s.regressed} regressed**, ${s.preExisting} pre-existing, ${s.improved} improved, ${s.unknown} inconclusive.`)
    push(`- **Executed:** \`${b.executedCommand}\` in isolated worktrees; the working checkout was not touched.`, '')
  }

  if (report.impact !== undefined) {
    const impact = report.impact
    const countLevel = (level: string): number =>
      impact.affected.filter((node) => node.level === level).length
    push('### Impact analysis ("what could this change affect?")', '')
    push(`- **Changed seeds:** ${impact.seeds.length}`)
    push(
      `- **Potentially affected:** ${impact.affected.length} — DIRECT ${countLevel('DIRECT')}, HIGH ${countLevel('HIGH')}, MEDIUM ${countLevel('MEDIUM')}, LOW ${countLevel('LOW')}`,
    )
    push(`- **Relevant existing tests:** ${impact.affectedTests.length}`)
    push(
      `- **Impact coverage:** ${impact.coverage.coveragePercent}% — ${impact.coverage.coveredAreas} covered, ${impact.coverage.uncoveredAreas} uncovered affected area(s)`,
    )
    // Graph completeness distinguishes the two unresolved-edge populations:
    // only impact-relevant edges (from seeds or traversal-reached nodes) can
    // make the assessment partial; repository-wide edges outside the impact
    // region are reported as a note, not as uncertainty about this change.
    const relevantUnresolved = impact.unresolvedEdges.length
    const repositoryUnresolved = impact.repositoryUnresolvedEdges.length
    let completenessLine: string
    if (impact.completeness === 'partial') {
      completenessLine = `PARTIAL — ${relevantUnresolved} impact-relevant unresolved relationship(s)`
      if (repositoryUnresolved > relevantUnresolved) {
        completenessLine += ` of ${repositoryUnresolved} repository-wide`
      }
    } else if (repositoryUnresolved > 0) {
      completenessLine = `COMPLETE — repository has ${repositoryUnresolved} unrelated unresolved relationship(s)`
    } else {
      completenessLine = 'COMPLETE'
    }
    push(`- **Graph completeness:** ${completenessLine}`)
    push('')

    const blastRadius = impact.affected
      .filter((node) => !node.changed)
      .sort((a, b) => a.distance - b.distance || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    if (blastRadius.length > 0) {
      push('Affected areas beyond the changed files (evidence: seed → … → affected):', '')
      push('```')
      for (const node of blastRadius.slice(0, 8)) {
        const chain =
          node.reachability === 'known' && node.via.length > 0
            ? node.via[0]!.join(' → ')
            : 'no graph evidence'
        push(`${node.path} — ${node.level}, distance ${node.distance}, via ${chain}`)
      }
      if (blastRadius.length > 8) push(`… and ${blastRadius.length - 8} more`)
      push('```', '')
    }

    if (impact.affectedTests.length > 0) {
      push('Relevant existing tests (evidence reversed for reading: test ← … ← seed):', '')
      push('```')
      for (const test of impact.affectedTests.slice(0, 8)) {
        const chain =
          test.evidencePaths.length > 0
            ? [...test.evidencePaths[0]!].reverse().join(' ← ')
            : test.path
        push(chain)
      }
      if (impact.affectedTests.length > 8) push(`… and ${impact.affectedTests.length - 8} more`)
      push('```', '')
    }

    if (impact.coverage.affectedAreas > 0) {
      const coveredShown = impact.coverage.covered.slice(0, 10)
      const uncoveredShown = impact.coverage.uncovered.slice(0, 10)
      const overflowNote = (total: number, shown: number): string =>
        total > shown ? ` … and ${total - shown} more` : ''
      push(
        `Covered (${impact.coverage.coveredAreas}): ${coveredShown.length > 0 ? coveredShown.join(', ') : '—'}${overflowNote(impact.coverage.coveredAreas, coveredShown.length)}`,
      )
      push(
        `Uncovered (${impact.coverage.uncoveredAreas}): ${uncoveredShown.length > 0 ? uncoveredShown.map((path) => `⚠ ${path}`).join(', ') : '—'}${overflowNote(impact.coverage.uncoveredAreas, uncoveredShown.length)}`,
      )
      push('')
    }

    const review = impact.predictionReview
    if (review !== undefined && review.mode !== 'not-applicable') {
      if (review.mode === 'per-test') {
        push(
          `- **Prediction vs reality:** predicted ${review.predictedTests} relevant test(s); observed ${review.observedRegressions} regression(s); predicted ${review.predictedRegressions}; prediction misses ${review.predictionMisses.length}.`,
        )
        for (const miss of review.predictionMisses) {
          push(
            `  - prediction miss: "${miss.test}"${miss.file !== undefined ? ` (${miss.file})` : ''} — outside the predicted impact population (analyzer incompleteness, not additional risk in the change)`,
          )
        }
      } else {
        push(
          `- **Prediction vs reality:** predicted ${review.predictedTests} relevant test(s); observed ${review.observedRegressions} regression(s); per-test attribution unavailable (suite-level runner outcomes), so predicted/misses are not meaningful here.`,
        )
      }
      push('')
    }
  }

  push('### Findings', '')
  if (report.findings.length === 0) {
    push('None. No contract violations or anomalies detected by the deterministic scope analysis.', '')
  }
  for (const finding of report.findings) {
    push(`#### ${finding.id} — ${finding.findingClass} ${severityMark(finding.severity)}`, '')
    push(finding.message, '')
    push(`- **Claim:** ${finding.evidence.claim}`)
    push(`- **Observation:** ${finding.evidence.observation}`)
    for (const changed of finding.evidence.changedLines) {
      const hunks = changed.hunks
        .map((hunk) => `@${hunk.before}→${hunk.after} (+${hunk.added}/-${hunk.removed})`)
        .join(' ')
      push(`- **Changed lines:** \`${changed.file}\` ${hunks}`)
    }
    push(`- **Reproduce:** \`${finding.evidence.reproduction}\``)
    push('')
  }

  push('---', '')
  push(
    '_Regression Guard distinguishes scope, regression verification, and impact analysis, and reports uncertainty explicitly rather than treating unknown states as safe: what cannot be verified stays NOT VERIFIED._',
    '',
  )

  return lines.join('\n')
}
