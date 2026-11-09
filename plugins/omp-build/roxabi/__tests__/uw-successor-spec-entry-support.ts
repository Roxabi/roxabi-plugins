import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { calculateTier } from '../../../issue-triage/skills/shared/domain/complexity.ts'
import { createIssueWriter, type IssueWritePorts } from '../../../issue-triage/skills/shared/domain/issue-write.ts'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import type { History } from '../../engine/history-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import { resolveSpecEffective } from '../../engine/spec-effective.ts'
import type { UwGraphObservation } from '../../engine/uw-graph.ts'
import { prepareSpecAllocation } from '../../engine/uw-identity.ts'
import { canonicalSpec } from '../../engine/uw-spec.ts'
import { createOperatorConfirmation } from '../../omp/omp-operator-confirmation.ts'
import { fixtureHostReviewClassCatalogues } from '../../testing/host-catalogue-fixture.ts'
import { operatorDialogUi } from '../../testing/operator-dialog-ui.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { observedUwWithoutPullRequests } from '../../testing/uw-completion-observation.ts'
import { guardedCauseWriter } from '../uw-cause-guard.ts'
import { createUwOperations } from '../uw-operations.ts'
import { createInstalledObservedUwReadPort } from '../uw-read-port.ts'

export const uw: Scope = { repository: 'acme/payments', target: 'acme/payments#41' }
const issue = { repository: uw.repository, number: 41 }
export const time = '2026-10-21T00:00:00Z'
export const statement = 'Preserve existing authorized requests.'
const legacy = `# Acceptance Criteria\n\n- C1 : ${statement}`

function must<T>(result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string }[] }): T {
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.code).join(','))
  return result.value
}

export function setup(abandoned: boolean) {
  const fixtures = roxabiWorkflowFixtures()
  const spec = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: [{ id: 'C1', statement }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    }),
  )
  const original = parseIssueSpecBody({
    uw,
    raw: rawSource(uw.target, renderIssueSpecBody(spec, { complexity: 5 }), time),
  })
  if (original.status !== 'conformant') throw new Error('expected a conformant historical mandate snapshot')
  const ownSpec = fixtures.ownSpecFromSnapshot(uw, original.snapshot)
  const mandate = fixtures.featureMandate(uw, {
    recordId: 'mandate-original',
    operationId: 'mandate-operation',
    ownSpec,
  })
  const allocation = fixtures.identityAllocation(uw, ownSpec.identityAllocations[0].recordId)
  const abandon = must(
    buildRecord({
      version: 1,
      repository: uw.repository,
      target: uw.target,
      recordId: 'abandon-original',
      runId: 'abandon-run',
      operationId: 'abandon-operation',
      kind: 'operator-control',
      payload: {
        control: 'abandon',
        controlId: 'abandon-original',
        predecessor: null,
        mandate: { scope: uw, recordId: mandate.recordId, kind: 'mandate' },
      },
    }),
  )
  const records: CanonicalRecord[] = abandoned ? [allocation, mandate, abandon] : [allocation, mandate]
  const comments: History['comments'] = []
  for (const [index, record] of records.entries()) {
    const frames = must(encodeParts(record, `# ${record.kind}`, 65536))
    comments.push(
      ...frames.map((body, frame) => ({
        locator: `comment-${index}-${frame}`,
        nativeId: `${index * 10 + frame + 1}`,
        body,
        author: 'operator',
        createdAt: time,
        updatedAt: time,
      })),
    )
  }
  const history = decodeHistory({
    scope: uw,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments,
    diagnostics: [],
  })
  let body = legacy
  let title = 'Normalize legacy UW'
  let confirmations = 0
  let patches = 0
  let labels = ['size:S']
  const graph = (): Extract<UwGraphObservation, { status: 'complete' }> => ({
    status: 'complete',
    root: uw,
    observedAt: time,
    nodes: [
      {
        uw,
        title,
        raw: rawSource(uw.target, body, time),
        updatedAt: time,
        labels: [...labels],
        wayfinderLabels: [],
        parent: null,
        children: [],
        blockers: [],
        native: { state: 'OPEN', stateReason: null },
      },
    ],
  })
  const read = async (scope: Scope) =>
    createInstalledObservedUwReadPort({
      observation: await observedUwWithoutPullRequests({
        graph: graph(),
        histories: [history],
        catalogues: fixtureHostReviewClassCatalogues(),
      }),
    }).readUw(scope)
  const unsupported = async (): Promise<never> => {
    throw new Error('unexpected issue mutation')
  }
  const issuePorts: IssueWritePorts = {
    read: async () => ({
      issue,
      title,
      body,
      updatedAt: time,
      nativeState: { state: 'OPEN', stateReason: null },
      labels: [...labels],
      parent: null,
      children: [],
      blockers: [],
    }),
    create: unsupported,
    patch: async (_issue, value) => {
      patches++
      body = value.body
      title = value.title ?? title
    },
    updateLabels: async (_issue, change) => {
      const next = new Set(labels)
      for (const label of change.remove) next.delete(label)
      for (const label of change.add) next.add(label)
      labels = [...next]
    },
    addChild: unsupported,
    removeChild: unsupported,
    addBlocker: unsupported,
    removeBlocker: unsupported,
    setNativeState: unsupported,
  }
  const operator = createOperatorConfirmation({
    agent: { kind: 'main', depth: 0 },
    hasUI: true,
    mode: 'tui',
    ui: operatorDialogUi(async () => {
      confirmations++
      return 'confirm'
    }),
    localProtocolOptions: consultableProtocolOptions(),
  } as unknown as ExtensionContext)
  const operations = createUwOperations({
    read,
    abandon: unsupported,
    adjustCauseDependency: unsupported,
    resolveSpecEffective,
    readCreated: read,
    closeLinked: async () => {
      throw new Error('unexpected close-linked effect')
    },
    listReports: async (root) => ({ ok: true, value: { root, reports: [] } }),
    guardParent: async () => {},
    writer: createIssueWriter(issuePorts),
    guardedWriter: (beforeEffect) => guardedCauseWriter(issuePorts, createIssueWriter, beforeEffect),
    causeOperations: () => ({
      adjudicateCause: async () => {
        throw new Error('unexpected adjudication')
      },
      createSister: async () => {
        throw new Error('unexpected sister')
      },
      promoteReport: async () => {
        throw new Error('unexpected promotion')
      },
    }),
    operator,
    prepareSpecAllocation,
    renderIssueSpecBody,
    calculateTier,
    publishIdentity: async () => {
      throw new Error('existing C1 must not require identity publication')
    },
    acceptMaterial: async () => {
      throw new Error('unexpected material acceptance')
    },
    scopeOf: () => uw,
  })
  const parsed = parseIssueSpecBody({ uw, raw: rawSource(uw.target, legacy, time) })
  const criterion = parsed.analysis.criterionSources[0]
  if (criterion === undefined) throw new Error('legacy criterion must be observable')
  const request = {
    uw,
    sourceBodySha256: rawSource(uw.target, legacy, time).bodySha256,
    title: 'Normalize legacy UW',
    draft: {
      criteria: [{ kind: 'existing' as const, id: 'C1' as const, statement }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    },
    normalization: [
      { kind: 'kept' as const, source: criterion.span, target: { kind: 'existing' as const, id: 'C1' as const } },
    ],
    factors: { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
    writes: {
      labels: { add: [], remove: [] },
      relations: { addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [] },
    },
    tierOverride: null,
  }
  return {
    history,
    mandate,
    original,
    parsed,
    read,
    operations,
    request,
    counts: () => ({ confirmations, patches }),
    body: () => body,
  }
}
