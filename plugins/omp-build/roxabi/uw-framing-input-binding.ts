import {
  canonicalValueDigest,
  FRAMING_PROCEDURE_FILES,
  framingAggregateInputSchema,
  framingInvocationBindingSchema,
  sameScope,
  specDigest,
} from '../dist/contracts.js'
import type { FramingInvocationBinding } from '../engine/framing-context-schema.ts'
import type { UwDiagnostic, UwResult } from '../engine/uw-diagnostics.ts'
import type { FramingAggregateInput } from '../engine/uw-framing-schema.ts'

type AggregateMember = FramingAggregateInput['members'][number]
export type BoundInput = { aggregate: FramingAggregateInput; binding: FramingInvocationBinding; root: AggregateMember }
function repositoryDiagnostic(repository: string, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'repository', repository }, related: [] }
}
function refusal(repository: string, code: string, message: string): UwResult<never> {
  return { ok: false, diagnostics: [repositoryDiagnostic(repository, code, message)] }
}
/** The exact procedure manifest: self-digest and every stage file pinned to the plugin commit. */
function proceduresExact(procedures: FramingInvocationBinding['procedures']): boolean {
  const { digest: manifestDigest, ...manifest } = procedures
  return (
    canonicalValueDigest(manifest) === manifestDigest &&
    manifest.procedures.every(
      ({ stage, file }) =>
        file.repository === manifest.plugin.repository &&
        file.commit === manifest.plugin.commit &&
        file.path === `${manifest.plugin.root}/${FRAMING_PROCEDURE_FILES[stage]}` &&
        manifest.plugin.files.some((item) => canonicalValueDigest(item) === canonicalValueDigest(file)),
    )
  )
}

function sourceRootProblem(aggregate: FramingAggregateInput, root: AggregateMember): string | null {
  const source = aggregate.source
  if (source.kind === 'free-text') {
    const captured =
      root.slot.kind === 'new' &&
      root.slot.repository === source.repository &&
      specDigest(source.acceptedArgs) === source.bodySha256
    return captured ? null : 'Free-text source or root does not match its capture'
  }
  return root.slot.kind === 'existing' && sameScope(root.slot.uw, source.uw)
    ? null
    : 'Issue source must remain the selected existing root'
}

export function bindInput(
  input: FramingAggregateInput,
  invocation: FramingInvocationBinding,
  repository: string,
): UwResult<BoundInput> {
  const parsed = framingAggregateInputSchema.safeParse(input)
  const binding = framingInvocationBindingSchema.safeParse(invocation)
  if (!parsed.success || !binding.success)
    return refusal(repository, 'framing-input-invalid', 'Aggregate or invocation is invalid')
  if (!proceduresExact(binding.data.procedures))
    return refusal(repository, 'framing-procedures-invalid', 'The exact procedure manifest and pinned files must match')
  const aggregate = parsed.data
  if (binding.data.sourceDigest !== canonicalValueDigest(aggregate.source))
    return refusal(repository, 'framing-source-mismatch', 'Invocation does not bind the exact captured source')
  const root = aggregate.members.find((member) => member.slot.key === aggregate.root)
  if (root === undefined) return refusal(repository, 'framing-root-missing', 'Aggregate root is missing')
  const mismatch = sourceRootProblem(aggregate, root)
  if (mismatch !== null) return refusal(repository, 'framing-source-mismatch', mismatch)
  if (aggregate.kind === 'wayfinder' && aggregate.members.some((member) => member.kind !== 'wayfinder'))
    return refusal(
      repository,
      'framing-wayfinder-invalid',
      'A Wayfinder aggregate cannot allocate or contain UW members',
    )
  return { ok: true, value: { aggregate, binding: binding.data, root } }
}
