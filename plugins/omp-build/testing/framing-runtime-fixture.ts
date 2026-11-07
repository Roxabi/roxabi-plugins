import { canonicalValueDigest } from '../engine/canonical-value.ts'
import { FRAMING_PROCEDURE_FILES, type FramingInvocationBinding } from '../engine/framing-context-schema.ts'
import { specDigest } from '../engine/record-digests.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { FramingAggregateInput } from '../engine/uw-framing-schema.ts'
import type { FramingEffectGuard } from '../roxabi/uw-framing-contract.ts'
import { buildFramingSourceBinding } from '../roxabi/uw-framing-prepare.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import type { nativeGitHub } from './framing-native-github.ts'

const repository = 'acme/app'
const pluginRepository = 'acme/example'
const commit = 'a'.repeat(40)
const digest = 'b'.repeat(64)
const files = (Object.keys(FRAMING_PROCEDURE_FILES) as (keyof typeof FRAMING_PROCEDURE_FILES)[]).map((stage) => ({
  source: 'git-file' as const,
  repository: pluginRepository,
  commit,
  path: `plugins/omp-build/${FRAMING_PROCEDURE_FILES[stage]}`,
  digest,
}))
const procedures = {
  format: 'omp-build-framing-procedures/1' as const,
  plugin: {
    name: 'omp-build' as const,
    version: '0.17.2',
    repository: pluginRepository,
    commit,
    root: 'plugins/omp-build',
    files,
  },
  procedures: [
    { stage: 'grilling' as const, file: files[0] },
    { stage: 'domain-modeling' as const, file: files[1] },
    { stage: 'codebase-design' as const, file: files[2] },
  ] as const,
}
const sections = { origin: 'Origin', context: 'Context', change: 'Change' }

type UwMember = Extract<FramingAggregateInput['members'][number], { kind: 'uw' }>
type Operations = Awaited<ReturnType<typeof createInstalledUwOperations>>
type Read = Awaited<ReturnType<Operations['readUw']>>
type GuardPoint = Parameters<FramingEffectGuard['check']>[0]

export const scope = (number: number): Scope => ({ repository, target: `${repository}#${number}` })
export const numberOf = (value: Scope): number => Number(value.target.slice(value.target.lastIndexOf('#') + 1))
export const codes = (diagnostics: readonly UwDiagnostic[]) => diagnostics.map((item) => item.code)

export async function installed(
  native: ReturnType<typeof nativeGitHub>,
  options: { confirm?: boolean; onConfirm?: () => void } = {},
) {
  // Only the test confirmation adapter requires Vitest's artifact-lifetime hook.
  const { fixture } = await import('./uw-operations-fixture.ts')
  let confirmations = 0
  const confirmation = fixture({
    confirm: options.confirm,
    onConfirm: () => {
      confirmations += 1
      options.onConfirm?.()
    },
  })
  const operations = await createInstalledUwOperations({
    cwd: '/fixture',
    gh: native.gh,
    readAuthor: 'automation',
    operator: confirmation.ports.operator,
  })
  return { operations, confirmations: () => confirmations }
}

/** The controller's revocable act guard is the declared external port of `frame`. */
export function effectGuard(revokeAt: (point: GuardPoint) => boolean = () => false) {
  const points: GuardPoint[] = []
  let revoked = false
  const guard: FramingEffectGuard = {
    async check(point) {
      points.push(point)
      if (revoked || revokeAt(point)) {
        revoked = true
        throw new Error('framing-effect-guard-revoked')
      }
    },
  }
  return { guard, points }
}

export function invocation(source: FramingAggregateInput['source']): FramingInvocationBinding {
  return {
    extensionInstanceId: 'extension',
    sessionId: 'session',
    agentId: 'main',
    generation: 1,
    revision: 1,
    sourceDigest: canonicalValueDigest(source),
    procedures: {
      ...procedures,
      procedures: [procedures.procedures[0], procedures.procedures[1], procedures.procedures[2]],
      digest: canonicalValueDigest(procedures),
    },
  }
}

export function uwMember(slot: UwMember['slot'], title: string, draftKey: string, statement: string): UwMember {
  return {
    kind: 'uw',
    slot,
    title,
    draft: {
      criteria: [{ kind: 'new', draftKey, statement }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections,
    },
    factors: { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
    tierOverride: null,
    labels: { add: [], remove: [] },
    merges: [],
    normalization: [
      { origin: null, decision: { kind: 'new', target: { kind: 'new', draftKey }, reason: 'Interview decision' } },
      ...(['origin', 'context', 'change'] as const).map((section) => ({
        origin: null,
        decision: {
          kind: 'new' as const,
          target: { kind: 'section' as const, section, range: { start: 0, end: sections[section].length } },
          reason: 'Interview context',
        },
      })),
    ],
  }
}

export function closure(): FramingAggregateInput {
  const acceptedArgs = 'Frame a request queue'
  return {
    kind: 'uw',
    root: 'root',
    source: { kind: 'free-text', acceptedArgs, bodySha256: specDigest(acceptedArgs), repository, materials: [] },
    members: [
      uwMember({ kind: 'new', key: 'root', repository }, 'Request queue', 'works', 'Requests are processed in order'),
      uwMember(
        { kind: 'new', key: 'foundation', repository },
        'Queue storage',
        'stored',
        'Requests are stored durably',
      ),
      uwMember({ kind: 'new', key: 'dependent', repository }, 'Queue worker', 'drained', 'Stored requests are drained'),
    ],
    edges: [
      { kind: 'parent-child', parent: 'root', child: 'foundation' },
      { kind: 'parent-child', parent: 'root', child: 'dependent' },
      { kind: 'blocker', dependent: 'dependent', blocker: 'foundation' },
    ],
    coverage: [
      {
        parent: 'root',
        assignments: [{ criterion: { kind: 'new', draftKey: 'works' }, children: ['foundation', 'dependent'] }],
      },
    ],
    foundations: [{ parent: 'root', child: 'foundation' }],
  }
}

export function bodySha(read: Read, number: number): string {
  const node = read.graph.nodes.find((item) => item.uw.target === scope(number).target)
  if (!node) throw new Error(`Native node ${number} is missing from the installed read`)
  return node.raw.bodySha256
}

/** An existing root whose existing native child is converted and preserved, never re-inserted. */
export async function existingRootAggregate(operations: Operations): Promise<FramingAggregateInput> {
  const rootRead = await operations.readUw(scope(41))
  const childRead = await operations.readUw(scope(42))
  const source = buildFramingSourceBinding(rootRead, [])
  if (!source.ok) throw new Error(`Cannot capture the native root source: ${codes(source.diagnostics)}`)
  return {
    kind: 'uw',
    root: 'root',
    source: source.value,
    members: [
      uwMember(
        {
          kind: 'existing',
          key: 'root',
          uw: scope(41),
          sourceBodySha256: bodySha(rootRead, 41),
          selection: { kind: 'command', reference: '#41' },
          observed: { nativeParent: null, children: [scope(42)], blockers: [] },
        },
        'Request queue',
        'works',
        'Requests are processed in order',
      ),
      uwMember(
        {
          kind: 'existing',
          key: 'child',
          uw: scope(42),
          sourceBodySha256: bodySha(childRead, 42),
          selection: { kind: 'native-child', parent: 'root', reference: '#42' },
          observed: { nativeParent: scope(41), children: [], blockers: [] },
        },
        'Queue storage',
        'stored',
        'Requests are stored durably',
      ),
    ],
    edges: [{ kind: 'parent-child', parent: 'root', child: 'child' }],
    coverage: [
      { parent: 'root', assignments: [{ criterion: { kind: 'new', draftKey: 'works' }, children: ['child'] }] },
    ],
    foundations: [],
  }
}

export async function prepare(operations: Operations, input: FramingAggregateInput) {
  const prepared = await operations.prepareFraming(input, invocation(input.source))
  if (!prepared.ok) throw new Error(`Expected a sealed aggregate: ${codes(prepared.diagnostics)}`)
  return prepared.value
}
