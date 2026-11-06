import type { IssueRef, IssueWriteObservation } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import { assessUwAdmission } from '../engine/uw-admission.ts'
import { assessUwCompletion } from '../engine/uw-completion.ts'
import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { SpecIdentityLedger } from '../engine/uw-identity.ts'
import { canonicalSpec } from '../engine/uw-spec.ts'
import { resolveAcceptedSpec } from '../engine/workflow-accepted-spec.ts'
import type { UwRead } from '../roxabi/uw-contract.ts'
import { fixtureHostReviewClassCatalogues } from './host-catalogue-fixture.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { UW } from './uw-operations-fixture-input.ts'

export type State = {
  title: string
  body: string
  labels: string[]
  children: IssueRef[]
  updatedAt: string
  nativeState: IssueWriteObservation['nativeState']
  ledger: SpecIdentityLedger
  acceptedSource: ExternalRecordRef | null
  acceptedRefused: boolean
  conflictOnPatch: boolean
  published: ExternalRecordRef[]
  patchCount: number
  readScopes: Scope[]
  issueReadIssues: IssueRef[]
  identityScopes: Scope[]
  patchedIssues: IssueRef[]
}

function acceptedResult(source: ExternalRecordRef | null, refused = false): UwRead['accepted'] {
  if (refused)
    return {
      status: 'refused',
      diagnostics: [
        {
          code: 'accepted-unreadable',
          message: 'Accepted chain is unreadable',
          location: { kind: 'native', uw: UW, connection: 'state' },
          related: [],
        },
      ],
    }
  if (source === null) return { status: 'absent' }
  throw new Error(`Accepted fixture source ${source.recordId} must be resolved from its authenticated history`)
}

function fixtureMandate(state: State) {
  const workflow = roxabiWorkflowFixtures()
  const content = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement: 'Keep payments auditable' }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!content.ok) throw new Error('Invalid declared accepted fixture Spec')
  const acceptedBody = renderIssueSpecBody(content.value)
  const acceptedParsed = parseIssueSpecBody({ uw: UW, raw: rawSource(UW.target, acceptedBody, state.updatedAt) })
  if (acceptedParsed.status !== 'conformant') throw new Error('Invalid accepted fixture body')
  const mandate =
    state.acceptedSource === null
      ? null
      : workflow.featureMandate(UW, {
          recordId: state.acceptedSource.recordId,
          operationId: `operation-${state.acceptedSource.recordId}`,
          body: acceptedBody,
          ownSpec: workflow.ownSpecFromSnapshot(UW, acceptedParsed.snapshot),
        })
  return { mandate, workflow }
}

export function readFixtureUw(state: State): UwRead {
  const { mandate, workflow } = fixtureMandate(state)
  const empty = (scope: Scope) =>
    decodeHistory({
      scope,
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      comments: [],
      diagnostics: [],
    })
  const rootHistory = mandate === null ? empty(UW) : workflow.historyFrom([mandate])
  const children = state.children.map((child) => ({
    repository: child.repository,
    target: `${child.repository}#${child.number}`,
  }))
  const histories = [rootHistory, ...children.map(empty)]
  const graph = {
    status: 'complete' as const,
    root: UW,
    observedAt: state.updatedAt,
    nodes: [
      {
        uw: UW,
        title: state.title,
        raw: rawSource(UW.target, state.body, state.updatedAt),
        updatedAt: state.updatedAt,
        labels: [...state.labels],
        wayfinderLabels: [],
        parent: null,
        children,
        blockers: [],
        native: { ...state.nativeState },
      },
      ...children.map((child) => ({
        uw: child,
        title: 'Referenced UW',
        raw: rawSource(child.target, '', state.updatedAt),
        updatedAt: state.updatedAt,
        labels: [],
        wayfinderLabels: [],
        parent: UW,
        children: [],
        blockers: [],
        native: { state: 'OPEN' as const, stateReason: null },
      })),
    ],
  }
  const catalogues = fixtureHostReviewClassCatalogues()
  const observation: UwCompletionObservation = {
    status: 'complete',
    root: UW,
    graph,
    histories,
    catalogues,
    delivery: [UW, ...children].map((scope) => ({ uw: scope, pullRequests: [], integrations: [], commits: [] })),
  }
  const completion = assessUwCompletion(observation)
  const parsed = parseIssueSpecBody({ uw: UW, raw: rawSource(UW.target, state.body, state.updatedAt) })
  const proposed =
    parsed.status === 'conformant'
      ? { ok: true as const, snapshot: parsed.snapshot }
      : { ok: false as const, diagnostics: parsed.diagnostics }
  const resolved = mandate === null ? null : resolveAcceptedSpec(mandate, histories)
  if (resolved !== null && !resolved.ok)
    throw new Error(`Cannot resolve fixture accepted Spec: ${JSON.stringify(resolved.evidence)}`)
  const accepted: UwRead['accepted'] = state.acceptedRefused
    ? acceptedResult(null, true)
    : resolved === null
      ? { status: 'absent' }
      : { status: 'accepted', value: resolved.spec }
  const admission = assessUwAdmission({
    phase: 'initial-selection',
    uw: UW,
    graph,
    proposed,
    accepted,
    identities: state.ledger,
    histories,
    catalogues,
    completion,
  })
  return {
    uw: UW,
    parsed,
    identity: { ok: true, value: state.ledger },
    proposed,
    accepted,
    admission,
    histories,
    catalogues,
    causalObservation: { status: 'complete', histories, catalogues },
    graph,
    observation,
    completion,
  }
}
