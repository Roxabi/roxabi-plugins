import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { type FixtureNativeWorld, observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { parseRecord } from '../record-construction.ts'
import type { Scope } from '../record-values.ts'
import type { MandateRecord } from '../workflow-control.ts'
import { featureMandate as baseFeatureMandate, must, PARENT, SCOPE } from './workflow-test-support.ts'

export const landingFixtures = roxabiWorkflowFixtures()

export const nativeBody = strictSpecBody('Ship the bounded workflow')
const nativeParsed = parseIssueSpecBody({ uw: SCOPE, raw: rawSource(SCOPE.target, nativeBody, '2026-10-21T12:00:00Z') })
if (nativeParsed.status !== 'conformant') throw new Error('Expected a conformant native Spec')
const nativeSnapshot = nativeParsed.snapshot
const parentParsed = parseIssueSpecBody({
  uw: PARENT,
  raw: rawSource(PARENT.target, nativeBody, '2026-10-21T12:00:00Z'),
})
if (parentParsed.status !== 'conformant') throw new Error('Expected a conformant parent Spec')
export const parentSnapshot = parentParsed.snapshot
export const childCommitment = {
  scope: SCOPE,
  snapshot: nativeParsed.snapshot,
  specVersion: nativeParsed.snapshot.spec.version,
  tier: 'S' as const,
}
export const rootNode = {
  scope: SCOPE,
  title: 'Bounded workflow',
  body: nativeBody,
  updatedAt: '2026-10-21T12:00:00Z',
  labels: ['size:S'],
  parent: null,
  children: [],
  blockers: [],
  state: 'OPEN' as const,
  stateReason: null,
}
export const parentNodes: FixtureNativeWorld['nodes'] = [
  { ...rootNode, parent: PARENT },
  {
    scope: PARENT,
    title: 'Parent',
    body: nativeBody,
    updatedAt: '2026-10-21T12:00:00Z',
    labels: ['size:S'],
    parent: null,
    children: [SCOPE],
    blockers: [],
    state: 'OPEN',
    stateReason: null,
  },
]
export const pr: Scope = { repository: SCOPE.repository, target: 'acme/app#99' }
// This pure classification fixture declares an IO world, not a real Git repository.
const declaredBase = 'b'.repeat(40)
const nativePulls: FixtureNativeWorld['pullRequests'] = [
  {
    scope: pr,
    branch: 'feature/bounded',
    base: 'main',
    head: declaredBase,
    baseTip: declaredBase,
    state: 'OPEN',
    mergeCommit: null,
    author: 'operator',
  },
]

export function featureMandate(): MandateRecord {
  const feature = baseFeatureMandate()
  const result = must(
    parseRecord({
      ...feature,
      payload: { ...feature.payload, ownSpec: landingFixtures.ownSpecFromSnapshot(SCOPE, nativeSnapshot) },
    }),
  )
  if (result.kind !== 'mandate') throw new Error('Expected a mandate')
  return result
}

export async function nativeCausal(histories: readonly DecodedHistory[], nodes: FixtureNativeWorld['nodes']) {
  return observeFixtureNativeWorld({
    root: SCOPE,
    nodes,
    histories,
    pullRequests: histories.some(
      (history) => history.source.scope.repository === pr.repository && history.source.scope.target === pr.target,
    )
      ? nativePulls
      : [],
    commits: [{ repository: SCOPE.repository, sha: declaredBase, parents: [] }],
    comparisons: [
      { repository: SCOPE.repository, base: declaredBase, head: declaredBase, status: 'identical', commits: [] },
    ],
  })
}

export async function landingInput(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  pullRequest: Scope,
  parentScopes: readonly Scope[],
  nodes: FixtureNativeWorld['nodes'],
) {
  const causal = await nativeCausal(histories, nodes)
  const config = mandate.payload.config
  return {
    histories: causal.histories,
    authorityHistories: causal.histories,
    catalogues: causal.catalogues,
    observation: causal.observation,
    uwGraph: causal.observation.graph,
    native: { branch: 'feature/bounded', base: 'main', pullRequest, linkedIssueScopes: [SCOPE] },
    parentScopes,
    current: {
      productVersion: config.productVersion,
      configVersion: config.version,
      configDigest: config.digest,
      supportedConfigVersions: [config.version],
      proposedSpec: { ok: true as const, snapshot: nativeSnapshot },
      currentChildren: { ok: true as const, value: [] },
    },
    localInhibit: null,
  }
}
