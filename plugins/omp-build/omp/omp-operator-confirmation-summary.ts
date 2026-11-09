import type { PreparedOperatorProposal } from '../roxabi/uw-contract.ts'
import { framingSummary } from './omp-operator-confirmation-framing.ts'

const ignored: Record<string, true> = { format: true, invocation: true, materials: true, digest: true }

function appendFacts(lines: string[], value: unknown, name: string, depth: number): void {
  if (value == null || depth > 8) return
  const label = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ')
  if (typeof value !== 'object') {
    lines.push(`${'  '.repeat(depth)}${label} : ${String(value)}`)
    return
  }
  if (Array.isArray(value)) {
    if (!value.length) return
    lines.push(`${'  '.repeat(depth)}${label} :`)
    value.forEach((item, index) => {
      appendFacts(lines, item, `${index + 1}`, depth + 1)
    })
    return
  }
  const entries = Object.entries(value).filter(([key]) => !ignored[key])
  if (!entries.length) return
  if (name) lines.push(`${'  '.repeat(depth)}${label} :`)
  entries.forEach(([key, item]) => {
    appendFacts(lines, item, key, name ? depth + 1 : depth)
  })
}

/** Render proposal facts without displaying serialized implementation data. */
export function proposalSummary(prepared: PreparedOperatorProposal): string[] {
  const proposal = prepared.proposal
  if (proposal.format === 'omp-build-uw-framing/1') return framingSummary(proposal)
  const lines = [
    'Proposition à examiner',
    `Opération : ${'operation' in proposal ? proposal.operation : proposal.format}`,
  ]
  appendFacts(lines, proposal, '', 0)
  lines.push('Les effets peuvent être partiels ; aucun retour arrière automatique.')
  return lines
}
