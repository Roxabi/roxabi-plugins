import { composedParentConsentSchema } from '../dist/contracts.js'
import type { PreparedOperatorProposal } from '../roxabi/uw-contract.ts'
import { summaryField } from './omp-operator-confirmation-field.ts'
import { framingSummary } from './omp-operator-confirmation-framing.ts'

const operationByFormat = {
  'omp-build-uw-reopen/1': 'reopen',
  'omp-build-uw-abandon/1': 'abandon',
  'omp-build-material-acceptance/2': 'accept-material',
  'omp-build-cause-dependency-adjustment/1': 'adjust-cause-dependency',
} satisfies Record<
  Exclude<PreparedOperatorProposal['proposal'], { operation: string } | { format: 'omp-build-uw-framing/1' }>['format'],
  string
>

const ignored: Record<string, true> = {
  format: true,
  invocation: true,
  materials: true,
  digest: true,
  operationId: true,
  pendingDigest: true,
  nativeDigest: true,
  historyDigest: true,
  engagementDigest: true,
  nativeObservationDigest: true,
  parentProposalDigest: true,
}

function appendFacts(lines: string[], value: unknown, name: string, depth: number): void {
  if (value == null) return
  const label = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ')
  if (typeof value !== 'object') {
    lines.push(summaryField(`${'  '.repeat(depth)}Champ : `, label) + summaryField(' : ', String(value)))
    return
  }
  if (Array.isArray(value)) {
    if (!value.length) return
    lines.push(summaryField(`${'  '.repeat(depth)}Groupe : `, label))
    value.forEach((item, index) => {
      appendFacts(lines, item, `${index + 1}`, depth + 1)
    })
    return
  }
  const entries = Object.entries(value).filter(([key]) => !ignored[key])
  if (!entries.length) return
  if (name) lines.push(summaryField(`${'  '.repeat(depth)}Groupe : `, label))
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
    summaryField('Opération : ', 'operation' in proposal ? proposal.operation : operationByFormat[proposal.format]),
  ]
  if ('parentAcceptance' in proposal) {
    const consent = composedParentConsentSchema.safeParse(proposal.parentAcceptance)
    if (consent.success && consent.data.exactInputs.proposed.coverage) {
      const proposed = consent.data.exactInputs.proposed
      for (const assignment of proposed.coverage?.assignments ?? []) {
        const children = assignment.children
          .map((child) => {
            if (!('kind' in child)) return `${child.repository} : ${child.target}`
            const planned = proposed.children.find((item) => 'kind' in item && item.operationId === child.operationId)
            return `nouveau / en attente : ${planned && 'kind' in planned ? planned.plan.title : child.operationId}`
          })
          .join(', ')
        lines.push(
          summaryField(
            'Couverture parent : ',
            `${proposed.coverage?.parent.uw.target} — ${assignment.criterion} → ${children}`,
          ),
        )
      }
    }
  }
  appendFacts(lines, proposal, '', 0)
  lines.push('Les effets peuvent être partiels ; aucun retour arrière automatique.')
  return lines
}
