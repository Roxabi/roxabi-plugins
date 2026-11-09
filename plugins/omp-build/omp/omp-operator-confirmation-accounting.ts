import type { FramingProposal } from '../engine/uw-framing-receipt-schema.ts'
import type { FramingUwMember } from '../engine/uw-framing-schema.ts'

type Plan = FramingProposal['members'][number]
type FramingSourceRef = FramingUwMember['merges'][number]['sources'][number]
type Decision = FramingUwMember['normalization'][number]['decision']
type Target = Extract<Decision, { target: unknown }>['target']

function targetDescription(target: Target, member: FramingUwMember, plan: Plan | undefined): string {
  if (target.kind === 'existing') return target.id
  if (target.kind === 'new') {
    const id = plan?.allocation?.assignments.find((item) => item.draftKey === target.draftKey)?.id ?? target.draftKey
    const item = [...member.draft.criteria, ...member.draft.invariants].find(
      (entry) => entry.kind === 'new' && entry.draftKey === target.draftKey,
    )
    return `${id}${item ? ` — ${item.statement}` : ''}`
  }
  if (target.kind === 'section') return `section ${target.section}`
  return `${target.kind} ${target.index + 1}`
}

function spanExcerpt(raw: string, span: FramingSourceRef['span']): string {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .slice(span.start.line - 1, span.end.line)
  if (lines.length === 1) return (lines[0] ?? '').slice(span.start.column - 1, span.end.column - 1)
  if (lines.length) {
    lines[0] = (lines[0] ?? '').slice(span.start.column - 1)
    const last = lines.length - 1
    lines[last] = (lines[last] ?? '').slice(0, span.end.column - 1)
  }
  return lines.join('\n')
}

function excerpt(proposal: FramingProposal, source: FramingSourceRef): string {
  const origin = source.origin
  const raw =
    origin.kind === 'material'
      ? proposal.materials.find((item) => item.id === origin.id)?.raw.body
      : proposal.input.source.kind === 'issue' && origin.member === proposal.input.root
        ? proposal.input.source.body.body
        : undefined
  if (raw !== undefined) return spanExcerpt(raw, source.span)
  if (origin.kind !== 'native') return 'extrait indisponible'
  const analysis = proposal.members.find((member) => member.key === origin.member)?.nativeAnalysis?.analysis
  const sources = [
    ...(analysis?.criterionSources ?? []),
    ...(analysis?.invariantSources ?? []),
    ...(analysis?.contentSources ?? []),
  ]
  const item = sources.find((entry) => JSON.stringify(entry.span) === JSON.stringify(source.span))
  return item?.source ?? 'extrait indisponible'
}

export function accountingEffects(
  proposal: FramingProposal,
  member: FramingUwMember,
  plan: Plan | undefined,
): string[] {
  const lines: string[] = []
  const labels = { kept: 'Conservé', reworded: 'Reformulé', removed: 'Retiré', new: 'Ajouté' }
  for (const entry of member.normalization) {
    const decision = entry.decision
    const origin = entry.origin
    const before = origin && 'source' in decision ? excerpt(proposal, { origin, span: decision.source }) : ''
    const target = 'target' in decision ? ` → ${targetDescription(decision.target, member, plan)}` : ''
    const reason = 'reason' in decision ? ` ; motif : ${decision.reason}` : ''
    lines.push(`  ${labels[decision.kind]}${before ? ` : ${before}` : ''}${target}${reason}`)
  }
  for (const merge of member.merges) {
    const sources = merge.sources.map((source) => excerpt(proposal, source)).join(' + ')
    lines.push(`  Fusion : ${sources} → ${targetDescription(merge.target, member, plan)} ; motif : ${merge.reason}`)
  }
  return lines
}
