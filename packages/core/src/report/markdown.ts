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

export function renderMarkdownReport(report: VerificationReport): string {
  const lines: string[] = []
  const push = (...text: string[]) => lines.push(...text)

  push('# Change Integrity Report', '')
  push(`- **Contract:** ${report.contractId} — ${report.goal}`)
  push(`- **Compared:** \`${report.before}\` (${report.beforeSha.slice(0, 10)}) → \`${report.after}\` (${report.afterSha.slice(0, 10)})`)
  push(`- **Generated:** ${report.generatedAt}`)
  push('', '---', '')
  push(`## Verdict: ${report.verdict}`, '')

  push('### The three questions', '')
  push(`1. **Requested change accomplished?** ${report.threeQuestions.accomplished}`)
  push(`2. **Within permitted scope?** ${report.threeQuestions.withinScope}`)
  push(`3. **No regressions introduced?** NOT VERIFIED — requires the Baseline Engine (milestone 2)`)
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
    '_Regression Guard verifies changes against their contract. Question 3 is answered honestly as NOT VERIFIED until the Baseline Engine ships._',
    '',
  )

  return lines.join('\n')
}
