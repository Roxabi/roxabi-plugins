import { nativeComment } from '../../adapters/__tests__/github-workflow-support.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import { canonicalSpec } from '../../engine/uw-spec.ts'
import type { MandateRecord } from '../../engine/workflow-control.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { createWorkflowFixtures } from '../../testing/workflow-fixtures.ts'
import { type FeatureAuthority, resolveFeatureAuthority } from '../feature-continuation-admission.ts'
import { selectFeatureMandate } from '../feature-continuation-selection.ts'
import { loadContracts } from '../feature-engine.ts'
import { createInstalledUwReadPort } from '../uw-read-port.ts'
import type { GitRunner } from '../workflow-checkout.ts'
import { configPinDigest, effectiveWorkflowConfig } from '../workflow-config-digest.ts'
import { WORKFLOW_CONFIG_VERSION } from '../workflow-graph.ts'
import { successorGitHub } from './uw-successor-native-github.ts'

export const scope: Scope = { repository: 'acme/app', target: 'acme/app#41' }
export const child: Scope = { repository: 'acme/app', target: 'acme/app#42' }
export const sibling: Scope = { repository: 'acme/app', target: 'acme/app#43' }
export const head = 'a'.repeat(40)
export const branch = 'feature/bounded'
const time = '2026-10-27T12:00:00Z'
const fixtures = roxabiWorkflowFixtures()
const legacyEffective = effectiveWorkflowConfig('0.18.7', [])
export const legacyFixtures = createWorkflowFixtures({
  productVersion: '0.18.7',
  config: { version: WORKFLOW_CONFIG_VERSION, digest: configPinDigest(legacyEffective), effective: legacyEffective },
  head: '1111111111111111111111111111111111111111',
  editedAt: '2026-10-21T12:00:00Z',
})

function must<T>(result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string }[] }): T {
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.code).join(','))
  return result.value
}

export function proposal(statement: string) {
  return must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      sections: { origin: '', context: '', change: '' },
      criteria: [{ id: 'C1', statement }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
    }),
  )
}

export function specFor(uw: Scope, statement: string) {
  const body = renderIssueSpecBody(proposal(statement), { complexity: 2 })
  const parsed = parseIssueSpecBody({ uw, raw: rawSource(uw.target, body, time) })
  if (parsed.status !== 'conformant') throw new Error('successor fixture requires a conformant native Spec')
  const ownSpec = fixtures.ownSpecFromSnapshot(uw, parsed.snapshot)
  return {
    body,
    snapshot: parsed.snapshot,
    ownSpec,
    allocation: fixtures.identityAllocation(uw, ownSpec.identityAllocations[0].recordId),
  }
}

export function fixtureOwnSpec(own: MandateRecord['payload']['ownSpec']) {
  return {
    ...own,
    identityAllocations: own.identityAllocations.map((allocation) => {
      if (allocation.kind !== 'spec-identity') throw new Error('Fixture own Spec must use identity allocation refs')
      return { scope: allocation.scope, recordId: allocation.recordId, kind: allocation.kind }
    }),
  }
}

export function abandon(mandate: MandateRecord) {
  return must(
    buildRecord({
      version: 1,
      repository: mandate.repository,
      target: mandate.target,
      recordId: `abandon-${mandate.recordId}`,
      runId: `abandon-${mandate.recordId}`,
      operationId: `abandon-${mandate.recordId}`,
      kind: 'operator-control',
      payload: {
        control: 'abandon',
        controlId: `abandon-${mandate.recordId}`,
        predecessor: null,
        mandate: {
          scope: { repository: mandate.repository, target: mandate.target },
          recordId: mandate.recordId,
          kind: 'mandate',
        },
      },
    }),
  )
}

export function successorControl(
  predecessor: MandateRecord,
  successor: MandateRecord,
  recordId = 'historical-selection',
) {
  const successorRef = {
    scope: { repository: successor.repository, target: successor.target },
    recordId: successor.recordId,
    kind: 'mandate' as const,
  }
  return must(
    buildRecord({
      version: 1,
      repository: predecessor.repository,
      target: predecessor.target,
      recordId,
      runId: recordId,
      operationId: recordId,
      kind: 'operator-control',
      payload: {
        control: 'select-successor',
        controlId: recordId,
        mandate: {
          scope: { repository: predecessor.repository, target: predecessor.target },
          recordId: predecessor.recordId,
          kind: 'mandate',
        },
        predecessor: {
          scope: { repository: predecessor.repository, target: predecessor.target },
          recordId: predecessor.recordId,
          kind: 'mandate',
        },
        successor: successorRef,
      },
    }),
  )
}

type Native = ReturnType<typeof successorGitHub>['native']
type SeededWorld = {
  native: Native
  github: ReturnType<typeof successorGitHub>
  original: MandateRecord
  abandonment: CanonicalRecord
  seed(record: CanonicalRecord, author?: string): void
  parts(record: CanonicalRecord): ReturnType<typeof nativeComment>[]
  gitReplies: Map<string, string>
}
export type MutateWorld = (world: SeededWorld) => void

export async function selectionWorld(input: {
  uw: Scope
  issues: Parameters<typeof successorGitHub>[0]
  records: readonly CanonicalRecord[]
  original: MandateRecord
  abandonment: CanonicalRecord
  cwd: string
  mutate?: MutateWorld
}) {
  const github = successorGitHub(input.issues)
  const { native, gh } = github
  const parts = new Map<string, ReturnType<typeof nativeComment>[]>()
  let commentId = 0
  const recordKey = (record: CanonicalRecord) => `${record.target}\0${record.recordId}`
  const seed = (record: CanonicalRecord, author = 'automation') => {
    const number = Number(record.target.slice(record.target.lastIndexOf('#') + 1))
    const comments = native.comments.get(number)
    if (!comments) throw new Error(`missing native comments for ${record.target}`)
    const frames = must(encodeParts(record, `# ${record.kind}`, 65536)).map((body) => ({
      ...nativeComment(++commentId, body),
      user: { login: author },
    }))
    comments.push(...frames)
    parts.set(recordKey(record), frames)
  }
  for (const record of input.records) seed(record)
  const gitReplies = new Map([
    ['show HEAD:.dev/stack.yml', 'release:\n  model: trunk\n'],
    ['symbolic-ref --short refs/remotes/origin/HEAD', 'origin/main'],
    ['rev-parse --show-toplevel', input.cwd],
    [
      'worktree list --porcelain',
      `worktree /principal\nbranch refs/heads/main\n\nworktree ${input.cwd}\nbranch refs/heads/${branch}\n`,
    ],
    ['rev-parse --verify HEAD', head],
    ['rev-parse HEAD', head],
    ['branch --show-current', branch],
    ['status --porcelain', ''],
    ['show refs/remotes/origin/main:.dev/stack.yml', 'release:\n  model: trunk\n'],
  ])
  const seeded: SeededWorld = {
    native,
    github,
    original: input.original,
    abandonment: input.abandonment,
    seed,
    parts(record) {
      const observed = parts.get(recordKey(record))
      if (!observed) throw new Error(`record ${record.recordId} was not seeded`)
      return observed
    },
    gitReplies,
  }
  input.mutate?.(seeded)
  const git: GitRunner = async (_cwd, args) => {
    const key = args.join(' ')
    const stdout = gitReplies.get(`${_cwd}\0${key}`) ?? gitReplies.get(key)
    if (stdout === undefined) throw new Error(`unexpected Git request: ${args.join(' ')}`)
    return { code: 0, stdout, stderr: '' }
  }
  const engine = await loadContracts()
  if ('missing' in engine) throw new Error(`missing installed contract ${engine.missing}`)
  const reader = createInstalledUwReadPort({ cwd: input.cwd, gh, readAuthor: 'automation' })
  const before = await reader.readUw(input.uw)
  const resolution = await resolveFeatureAuthority({
    cwd: input.cwd,
    reference: input.uw.target,
    control: 'new',
    principal: false,
    git,
    gh,
    read: reader,
  })
  return {
    ...seeded,
    resolution,
    before,
    engine,
    reader,
    get authority(): FeatureAuthority {
      if ('kind' in resolution) throw new Error(`Expected fixture authority: ${JSON.stringify(resolution)}`)
      return resolution
    },
  }
}

export async function selectNew(subject: Awaited<ReturnType<typeof selectionWorld>>) {
  if ('kind' in subject.resolution) return subject.resolution
  return selectFeatureMandate('new', undefined, subject.resolution, undefined, subject.reader)
}

/** Retry through a new public authority read, never the pre-interruption selection. */
export async function retryNew(subject: Awaited<ReturnType<typeof selectionWorld>>) {
  const { cwd, git, gh } = subject.authority.context
  const fresh = await resolveFeatureAuthority({
    cwd,
    reference: scope.target,
    control: 'new',
    principal: false,
    git,
    gh,
    read: subject.reader,
  })
  if ('kind' in fresh) return fresh
  return selectFeatureMandate('new', undefined, fresh, undefined, subject.reader)
}

export async function abandonedLeaf(mutate?: MutateWorld) {
  const own = specFor(scope, 'Preserve authorized requests across explicit succession.')
  const original = legacyFixtures.featureMandate(scope, {
    recordId: 'mandate-original',
    operationId: 'mandate-operation',
    ownSpec: own.ownSpec,
    branch,
    base: 'main',
    lineageHead: 'c'.repeat(40),
  })
  const abandonment = abandon(original)
  return selectionWorld({
    uw: scope,
    issues: { 41: { title: 'Bounded succession', body: own.body, labels: ['size:S'] } },
    records: [own.allocation, original, abandonment],
    original,
    abandonment,
    cwd: '/work',
    mutate,
  })
}
