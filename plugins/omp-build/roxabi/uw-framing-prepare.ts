import { randomUUID } from 'node:crypto'
import { canonicalValueDigest, framingObservationDigest, framingProposalSchema, sameScope } from '../dist/contracts.js'
import type { FramingInvocationBinding } from '../engine/framing-context-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic, UwResult } from '../engine/uw-diagnostics.ts'
import type { FramingProposal } from '../engine/uw-framing-receipt-schema.ts'
import type {
  FramingAggregateInput,
  FramingMaterialCapture,
  FramingSourceBinding,
} from '../engine/uw-framing-schema.ts'
import type { UwRead } from './uw-contract.ts'
import { validateFramingConservation } from './uw-framing-conservation.ts'
import type { PreparedFramingProposal } from './uw-framing-contract.ts'
import { type BoundInput, bindInput } from './uw-framing-input-binding.ts'
import { type SealedMaterial, sealMaterials } from './uw-framing-material.ts'
import { type FramingPreparationPorts, planMember, sealInheritance } from './uw-framing-member-plan.ts'
import { validateFramingNativeCut } from './uw-framing-native-cut.ts'
import { validateTopology } from './uw-framing-topology.ts'
import { observation } from './uw-operation-observation.ts'
import { nativeIssueObservationDigest } from './uw-proposal-preparation.ts'

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function repositoryDiagnostic(repository: string, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'repository', repository }, related: [] }
}

/** Capture all source preconditions from the same complete, authenticated read. */
export function buildFramingSourceBinding(
  read: UwRead,
  materials: readonly FramingMaterialCapture[],
): UwResult<Extract<FramingSourceBinding, { kind: 'issue' }>> {
  const own = read.histories.filter((history) => sameScope(history.source.scope, read.uw))
  const native = observation(read)
  const node = read.graph.nodes.find((item) => sameScope(item.uw, read.uw))
  if (
    read.observation.status !== 'complete' ||
    read.graph.status !== 'complete' ||
    own.length !== 1 ||
    !own[0].source.complete ||
    own[0].source.diagnostics.length ||
    own[0].diagnostics.length ||
    native === null ||
    node === undefined ||
    !read.identity.ok
  )
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          read.uw,
          'framing-source-unavailable',
          'The complete source, native facts, and identity history are required',
        ),
      ],
    }
  return {
    ok: true,
    value: {
      kind: 'issue',
      uw: read.uw,
      body: node.raw,
      parserDigest: canonicalValueDigest(read.parsed.analysis),
      nativeDigest: nativeIssueObservationDigest(native),
      ledgerHead: read.identity.value.head,
      historyDigest: canonicalValueDigest(own[0]),
      engagementDigest: framingObservationDigest(read.observation),
      materials: [...materials],
    },
  }
}

const preparedFraming = new WeakMap<PreparedFramingProposal, 'available' | 'inflight'>()

/** Test the available process-local seal; digest alone is never authority to frame. */
export function isPreparedFramingProposal(value: PreparedFramingProposal): boolean {
  return preparedFraming.get(value) === 'available' && value.digest === canonicalValueDigest(value.proposal)
}

/** Reserve synchronously; only a proven no-action defer may release this exact object. */
export function reservePreparedFramingProposal(value: PreparedFramingProposal): ((deferred: boolean) => void) | null {
  if (!isPreparedFramingProposal(value)) return null
  preparedFraming.set(value, 'inflight')
  let settled = false
  return (deferred) => {
    if (settled) return
    settled = true
    if (deferred && value.digest === canonicalValueDigest(value.proposal)) preparedFraming.set(value, 'available')
    else preparedFraming.delete(value)
  }
}

function freezeRecursively(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
  for (const child of Object.values(value)) freezeRecursively(child)
  Object.freeze(value)
}

function refusal(repository: string, code: string, message: string): UwResult<never> {
  return { ok: false, diagnostics: [repositoryDiagnostic(repository, code, message)] }
}

async function readExistingMembers(
  aggregate: FramingAggregateInput,
  ports: FramingPreparationPorts,
): Promise<UwResult<Map<string, UwRead>>> {
  const reads = new Map<string, UwRead>()
  for (const member of aggregate.members) {
    if (member.slot.kind !== 'existing') continue
    try {
      reads.set(member.slot.key, await ports.read(member.slot.uw))
    } catch (error) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            member.slot.uw,
            'framing-read-unavailable',
            error instanceof Error ? error.message : String(error),
          ),
        ],
      }
    }
  }
  return { ok: true, value: reads }
}

/** An issue source is re-bound from the same complete root read it was captured from. */
function sourceFresh(
  aggregate: FramingAggregateInput,
  reads: ReadonlyMap<string, UwRead>,
  repository: string,
): UwResult<true> {
  const source = aggregate.source
  if (source.kind !== 'issue') return { ok: true, value: true }
  const rootRead = reads.get(aggregate.root)
  if (rootRead === undefined)
    return {
      ok: false,
      diagnostics: [diagnostic(source.uw, 'framing-source-unavailable', 'The issue source root was not read')],
    }
  const current = buildFramingSourceBinding(rootRead, source.materials)
  if (!current.ok) return current
  return canonicalValueDigest(current.value) === canonicalValueDigest(source)
    ? { ok: true, value: true }
    : refusal(
        repository,
        'framing-source-stale',
        'Source, parser, native, ledger, history, or engagement facts changed',
      )
}

function conservationDiagnostics(
  aggregate: FramingAggregateInput,
  reads: ReadonlyMap<string, UwRead>,
  materials: readonly SealedMaterial[],
): readonly UwDiagnostic[] {
  if (aggregate.kind !== 'uw') return []
  const uwMembers = aggregate.members.filter((member) => member.kind === 'uw')
  return validateFramingConservation({
    members: uwMembers.map((member) => ({
      member: member.slot.key,
      subject:
        member.slot.kind === 'existing'
          ? { kind: 'uw' as const, uw: member.slot.uw }
          : { kind: 'framing-member' as const, repository: member.slot.repository, member: member.slot.key },
      draft: member.draft,
      decisions: member.normalization,
      merges: member.merges,
    })),
    sources: [
      ...uwMembers.flatMap((member) => {
        const read = reads.get(member.slot.key)
        return read
          ? [
              {
                origin: { kind: 'native' as const, member: member.slot.key },
                identity: 'native-ledger' as const,
                analysis: read.parsed.analysis,
              },
            ]
          : []
      }),
      ...materials.map((material) => ({
        origin: { kind: 'material' as const, id: material.id },
        identity: 'none' as const,
        analysis: material.parser.analysis,
      })),
    ],
  })
}

function sealProposal(
  bound: BoundInput,
  materials: readonly SealedMaterial[],
  members: FramingProposal['members'],
  repository: string,
): UwResult<PreparedFramingProposal> {
  const { aggregate, binding, root } = bound
  const proposal = framingProposalSchema.safeParse({
    format: 'omp-build-uw-framing/1',
    operationId: `uw-framing:${randomUUID()}`,
    target:
      root.slot.kind === 'existing'
        ? { kind: 'existing', uw: root.slot.uw }
        : { kind: 'create', repository: root.slot.repository },
    input: aggregate,
    invocation: binding,
    materials,
    members,
  })
  if (!proposal.success)
    return refusal(repository, 'framing-proposal-invalid', 'Sealed aggregate did not match the canonical schema')
  const result: PreparedFramingProposal = { proposal: proposal.data, digest: canonicalValueDigest(proposal.data) }
  freezeRecursively(result)
  preparedFraming.set(result, 'available')
  return { ok: true, value: result }
}

/** Prepare one read-only aggregate from actual native readers, never from model assertions alone. */
export async function prepareFraming(
  input: FramingAggregateInput,
  invocation: FramingInvocationBinding,
  ports: FramingPreparationPorts,
): Promise<UwResult<PreparedFramingProposal>> {
  const repository = input.source.kind === 'issue' ? input.source.uw.repository : input.source.repository
  const bound = bindInput(input, invocation, repository)
  if (!bound.ok) return bound
  const { aggregate } = bound.value
  const topology = validateTopology(aggregate)
  if (topology.length > 0) return { ok: false, diagnostics: topology }
  const reads = await readExistingMembers(aggregate, ports)
  if (!reads.ok) return reads
  const checked = validateFramingNativeCut({ aggregate, reads: reads.value })
  if (!checked.ok) return checked
  const source = sourceFresh(aggregate, reads.value, repository)
  if (!source.ok) return source
  const materials = sealMaterials(aggregate, repository)
  if (!materials.ok) return materials
  const conservation = conservationDiagnostics(aggregate, reads.value, materials.value)
  if (conservation.length > 0) return { ok: false, diagnostics: [...conservation] }
  const members: FramingProposal['members'] = []
  for (const [ordinal, member] of aggregate.members.entries()) {
    const planned = await planMember(aggregate, ordinal, member, reads.value, ports, repository)
    if (!planned.ok) return planned
    members.push(planned.value)
  }
  if (!sealInheritance(aggregate, members))
    return refusal(repository, 'framing-ancestry-invalid', 'Planned ancestry cannot be sealed')
  return sealProposal(bound.value, materials.value, members, repository)
}
