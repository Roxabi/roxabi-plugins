import { describe, expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { classifyHistory } from '../history-classification.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { projectRecord } from '../record-projection.ts'
import type { Scope } from '../record-values.ts'
import type { MandateRecord } from '../workflow-control.ts'
import { assessFixMandate } from '../workflow-correction-admission.ts'
import { requireLandingMandate } from '../workflow-landing-admission.ts'
import { resolveOwnSpecAuthority, selectApplicableMandate } from '../workflow-mandate-admission.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import { landingFixtures, nativeBody, nativeSnapshot } from './workflow-authority-native-fixture.ts'
import { binding, facts, history, must, PARENT, SCOPE } from './workflow-test-support.ts'

function nativeChild(body: string) {
  const snapshot = nativeSnapshot(SCOPE, body)
  return { scope: SCOPE, snapshot, specVersion: snapshot.spec.version, tier: 'S' as const }
}

function featureMandate(): MandateRecord {
  return landingFixtures.featureMandate(SCOPE, {
    recordId: 'mandate-1',
    runId: 'run-1',
    operationId: 'op-mandate-1',
    branch: 'feature/bounded',
    base: 'main',
    lineageHead: null,
    body: nativeBody,
    ownSpec: landingFixtures.ownSpecFromSnapshot(SCOPE, nativeSnapshot(SCOPE, nativeBody)),
  })
}

async function parentWorld(childHistory: DecodedHistory, parentHistory: DecodedHistory, childBody: string) {
  return observeFixtureNativeWorld({
    root: SCOPE,
    nodes: [
      {
        scope: SCOPE,
        title: 'Child workflow',
        body: childBody,
        updatedAt: '2026-10-21T00:00:00Z',
        labels: ['size:S'],
        parent: PARENT,
        children: [],
        blockers: [],
        state: 'OPEN',
        stateReason: null,
      },
      {
        scope: PARENT,
        title: 'Parent workflow',
        body: nativeBody,
        updatedAt: '2026-10-21T00:00:00Z',
        labels: ['size:S'],
        parent: null,
        children: [SCOPE],
        blockers: [],
        state: 'OPEN',
        stateReason: null,
      },
    ],
    histories: [childHistory, parentHistory],
    pullRequests: [],
    commits: [],
    comparisons: [],
  })
}

describe('workflow authority behavior', () => {
  test('projects an accounted mandate without granting review authority or reading a broken review', () => {
    const record = featureMandate()
    const source = history([record])
    const broken = decodeHistory({
      ...source.source,
      comments: [
        ...source.source.comments,
        {
          locator: `${SCOPE.target}:comment:999`,
          nativeId: '999',
          body: '<!-- omp-build-record v=1 kind=review id=review-missing operationId=op-broken-review part=1/2 data=e30 -->',
          author: 'operator',
          createdAt: '2026-10-21T00:00:00Z',
          updatedAt: '2026-10-21T00:00:00Z',
        },
      ],
    })
    expect(classifyHistory(broken).classes.find((entry) => entry.operationId === record.operationId)?.authority).toBe(
      'accounted',
    )
    expect(projectRecord(record, broken, null)).toMatchObject({ ok: true })
    expect(projectRecord(record, broken, null, []).ok).toBe(true)
  })
  test('refuses abandoned and revoked mandates instead of reporting them missing', async () => {
    const record = featureMandate()
    const abandoned = must(
      parseRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'abandon-1',
        runId: 'run-1',
        operationId: 'op-abandon',
        kind: 'operator-control',
        inputs: [record.recordId],
        payload: {
          control: 'abandon',
          controlId: 'control-abandon',
          predecessor: null,
          mandate: { scope: SCOPE, recordId: record.recordId, kind: 'mandate' },
        },
      }),
    )
    const issue = history([record, abandoned])
    const causal = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Bounded workflow',
          body: nativeBody,
          updatedAt: '2026-10-21T00:00:00Z',
          labels: ['size:S'],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories: [issue],
      pullRequests: [],
      commits: [],
      comparisons: [],
    })
    expect(selectApplicableMandate(issue, [], causal)).toMatchObject({
      status: 'refused',
      reason: 'abandoned',
    })
    expect(
      assessFixMandate({
        target: { scope: SCOPE, kind: 'issue', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [SCOPE],
        history: issue,
        linkedIssueHistory: null,
        causal,
      }),
    ).toMatchObject({ status: 'refused', reason: 'abandoned' })
    const empty = history([])
    const emptyCausal = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Bounded workflow',
          body: nativeBody,
          updatedAt: '2026-10-21T00:00:00Z',
          labels: ['size:S'],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories: [empty],
      pullRequests: [],
      commits: [],
      comparisons: [],
    })
    const missing = selectApplicableMandate(empty, [], emptyCausal)
    expect(missing.status === 'refused' && missing.reason).toBe('missing')
  })
  test('does not borrow child authority from a revoked epic parent through its successor', async () => {
    const child = featureMandate()
    const parentOne = landingFixtures.epicMandate(PARENT, [nativeChild(nativeBody)], {
      recordId: 'epic-parent-one',
      runId: 'run00001',
      operationId: 'op-epic-parent-one',
      body: nativeBody,
      ownSpec: landingFixtures.ownSpecFromSnapshot(PARENT, nativeSnapshot(PARENT, nativeBody)),
    })
    const parentOneRef = landingFixtures.mandateRef(parentOne)
    const parentTwo = landingFixtures.epicMandate(PARENT, [], {
      recordId: 'epic-parent-two',
      runId: 'run00002',
      operationId: 'op-epic-parent-two',
      body: nativeBody,
      ownSpec: landingFixtures.ownSpecFromSnapshot(PARENT, nativeSnapshot(PARENT, nativeBody)),
      antecedent: parentOneRef,
    })
    const revokedParent = must(
      buildRecord({
        version: 1,
        repository: PARENT.repository,
        target: PARENT.target,
        recordId: 'abandon-epic-parent-one',
        runId: 'run00001',
        operationId: 'op-abandon-epic-parent-one',
        kind: 'operator-control',
        payload: { control: 'abandon', controlId: 'abandon-epic-parent-one', mandate: parentOneRef, predecessor: null },
      }),
    )
    const selectedParent = must(
      buildRecord({
        version: 1,
        repository: PARENT.repository,
        target: PARENT.target,
        recordId: 'select-epic-parent-two',
        runId: 'run00002',
        operationId: 'op-select-epic-parent-two',
        kind: 'operator-control',
        payload: {
          control: 'select-successor',
          controlId: 'select-epic-parent-two',
          mandate: { scope: PARENT, recordId: parentTwo.recordId, kind: 'mandate' },
          predecessor: parentOneRef,
          successor: { scope: PARENT, recordId: parentTwo.recordId, kind: 'mandate' },
        },
      }),
    )
    const boundChild = must(
      parseRecord({
        ...child,
        payload: {
          ...child.payload,
          parent: parentOneRef,
          inheritedOwnSpecRefs: [
            { uw: PARENT, version: parentOne.payload.ownSpec.version, sourceAccepted: parentOneRef },
          ],
        },
      }),
    )
    if (boundChild.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const parentHistory = history([parentOne, revokedParent, parentTwo, selectedParent], PARENT)
    const childHistory = history([boundChild])
    const nodes = [
      {
        scope: SCOPE,
        title: 'Child workflow',
        body: nativeBody,
        updatedAt: '2026-10-21T00:00:00Z',
        labels: ['size:S'],
        parent: PARENT,
        children: [],
        blockers: [],
        state: 'OPEN' as const,
        stateReason: null,
      },
      {
        scope: PARENT,
        title: 'Parent workflow',
        body: nativeBody,
        updatedAt: '2026-10-21T00:00:00Z',
        labels: ['size:S'],
        parent: null,
        children: [SCOPE],
        blockers: [],
        state: 'OPEN' as const,
        stateReason: null,
      },
    ]
    const causal = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes,
      histories: [childHistory, parentHistory],
      pullRequests: [],
      commits: [],
      comparisons: [],
    })
    expect(selectApplicableMandate(childHistory, [parentHistory], causal)).toMatchObject({
      status: 'refused',
      reason: 'revoked',
    })
    expect(resolveOwnSpecAuthority(childHistory, [parentHistory], causal)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'revoked' })],
    })
    expect(
      reconstructWorkflow({
        evidence: { issue: childHistory, pullRequest: null, parents: [parentHistory], causal },
        facts: facts(),
        decisions: {
          reviewStep: null,
          epicStep: null,
          epicLand: null,
          ciWatchStatus: null,
          publish: { status: 'absent', evidence: [] },
          landing: { status: 'absent', evidence: [] },
          watch: { status: 'absent', evidence: [] },
        },
      }),
    ).not.toMatchObject({ status: 'action' })
    expect(
      assessFixMandate({
        target: { scope: SCOPE, kind: 'issue', branch: 'feature/bounded', base: 'main' },
        linkedIssueScopes: [SCOPE],
        history: childHistory,
        linkedIssueHistory: null,
        externalHistories: [parentHistory],
        causal,
      }),
    ).not.toMatchObject({ status: 'applicable' })
    const pull: Scope = { repository: SCOPE.repository, target: 'acme/app#99' }
    const pullHistory = history([binding(boundChild, pull)], pull)
    const code = 'b'.repeat(40)
    const landingCausal = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes,
      histories: [childHistory, parentHistory, pullHistory],
      pullRequests: [
        {
          scope: pull,
          branch: 'feature/bounded',
          base: 'main',
          head: code,
          baseTip: code,
          state: 'OPEN',
          mergeCommit: null,
          author: 'operator',
        },
      ],
      commits: [],
      comparisons: [],
    })
    expect(
      requireLandingMandate({
        histories: landingCausal.histories,
        authorityHistories: [childHistory, pullHistory, parentHistory],
        catalogues: landingCausal.catalogues,
        observation: landingCausal.observation,
        uwGraph: landingCausal.observation.graph,
        native: { branch: 'feature/bounded', base: 'main', pullRequest: pull, linkedIssueScopes: [SCOPE] },
        parentScopes: [PARENT],
        localInhibit: null,
        current: {
          productVersion: boundChild.payload.config.productVersion,
          configVersion: boundChild.payload.config.version,
          configDigest: boundChild.payload.config.digest,
          supportedConfigVersions: [boundChild.payload.config.version],
          proposedSpec: { ok: true, snapshot: nativeSnapshot(SCOPE, nativeBody) },
          currentChildren: { ok: true, value: [] },
        },
      }),
    ).toMatchObject({ ok: false })
  })
  test('permits Spec control through a mismatched parent commitment while delivery refuses the mismatch', async () => {
    const child = featureMandate()
    const parent = landingFixtures.epicMandate(PARENT, [nativeChild(strictSpecBody('parent C2'))], {
      recordId: 'parent-mandate',
      runId: 'parent01',
      operationId: 'op-parent',
      body: nativeBody,
      ownSpec: landingFixtures.ownSpecFromSnapshot(PARENT, nativeSnapshot(PARENT, nativeBody)),
    })
    const childWithParent = must(
      parseRecord({
        ...child,
        payload: {
          ...child.payload,
          parent: landingFixtures.mandateRef(parent),
          inheritedOwnSpecRefs: [
            {
              uw: PARENT,
              version: parent.payload.ownSpec.version,
              sourceAccepted: landingFixtures.mandateRef(parent),
            },
          ],
        },
      }),
    )
    if (childWithParent.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const childHistory = history([childWithParent])
    const parentHistory = history([parent], PARENT)
    const causal = await parentWorld(childHistory, parentHistory, nativeBody)

    expect(resolveOwnSpecAuthority(childHistory, [parentHistory], causal)).toMatchObject({
      ok: true,
      value: {
        mandate: { recordId: childWithParent.recordId },
        accepted: { ref: { version: child.payload.ownSpec.version } },
      },
    })
    expect(selectApplicableMandate(childHistory, [parentHistory], causal)).toMatchObject({
      status: 'refused',
      reason: 'materially-changed',
    })
  })
  test('does not treat presentation-only raw child differences as parent commitment drift', async () => {
    const child = featureMandate()
    const presentationBody = `\n${nativeBody}\n`
    const childRaw = nativeSnapshot(SCOPE, presentationBody).raw
    const childWithPresentation = must(
      parseRecord({
        ...child,
        payload: {
          ...child.payload,
          ownSpec: {
            ...child.payload.ownSpec,
            snapshot: { ...child.payload.ownSpec.snapshot, raw: childRaw },
          },
        },
      }),
    )
    if (childWithPresentation.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const parentBase = landingFixtures.epicMandate(PARENT, [nativeChild(nativeBody)], {
      recordId: 'parent-presentation',
      runId: 'parent02',
      operationId: 'op-parent-presentation',
      body: nativeBody,
      ownSpec: landingFixtures.ownSpecFromSnapshot(PARENT, nativeSnapshot(PARENT, nativeBody)),
    })
    const parentCommitment = parentBase.payload.children[0]
    if (parentCommitment === undefined) throw new Error('fixture parent has no child commitment')
    const parent = must(
      parseRecord({
        ...parentBase,
        payload: {
          ...parentBase.payload,
          children: [
            {
              ...parentCommitment,
              snapshot: {
                ...child.payload.ownSpec.snapshot,
                raw: { ...child.payload.ownSpec.snapshot.raw, lastEditedAt: '2026-10-22T00:00:00Z' },
              },
            },
          ],
        },
      }),
    )
    if (parent.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const boundChild = must(
      parseRecord({
        ...childWithPresentation,
        payload: {
          ...childWithPresentation.payload,
          parent: landingFixtures.mandateRef(parent),
          inheritedOwnSpecRefs: [
            {
              uw: PARENT,
              version: parent.payload.ownSpec.version,
              sourceAccepted: landingFixtures.mandateRef(parent),
            },
          ],
        },
      }),
    )
    if (boundChild.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const childHistory = history([boundChild])
    const parentHistory = history([parent], PARENT)
    const causal = await parentWorld(childHistory, parentHistory, presentationBody)

    expect(selectApplicableMandate(childHistory, [parentHistory], causal)).toMatchObject({
      status: 'applicable',
      mandate: { recordId: boundChild.recordId },
    })
  })
  test('refuses own Spec control through incomplete parents and permission excess', async () => {
    const child = featureMandate()
    const parentBase = landingFixtures.epicMandate(PARENT, [nativeChild(nativeBody)], {
      recordId: 'restricted-parent',
      runId: 'parent03',
      operationId: 'op-restricted-parent',
      body: nativeBody,
      ownSpec: landingFixtures.ownSpecFromSnapshot(PARENT, nativeSnapshot(PARENT, nativeBody)),
    })
    const parent = must(
      parseRecord({
        ...parentBase,
        payload: { ...parentBase.payload, permissions: { landing: false, correct: true } },
      }),
    )
    if (parent.kind !== 'mandate') throw new Error('fixture is not a mandate')
    const childWithParent = must(
      parseRecord({
        ...child,
        payload: {
          ...child.payload,
          parent: landingFixtures.mandateRef(parent),
          inheritedOwnSpecRefs: [
            {
              uw: PARENT,
              version: parent.payload.ownSpec.version,
              sourceAccepted: landingFixtures.mandateRef(parent),
            },
          ],
        },
      }),
    )
    const childHistory = history([childWithParent])
    const parentHistory = history([parent], PARENT)
    const causal = await parentWorld(childHistory, parentHistory, nativeBody)
    expect(resolveOwnSpecAuthority(childHistory, [parentHistory], causal)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'incompatible' })],
    })
    const incompleteParent = { ...parentHistory, source: { ...parentHistory.source, complete: false } }
    expect(resolveOwnSpecAuthority(childHistory, [incompleteParent], causal)).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: expect.any(String) })]),
    })
  })
  test('refuses own Spec control through an ambiguous parent mandate history', async () => {
    const child = featureMandate()
    const first = landingFixtures.epicMandate(PARENT, [nativeChild(nativeBody)], {
      recordId: 'ambiguous-parent-a',
      runId: 'parent04',
      operationId: 'op-parent-a',
      body: nativeBody,
      ownSpec: landingFixtures.ownSpecFromSnapshot(PARENT, nativeSnapshot(PARENT, nativeBody)),
    })
    const second = landingFixtures.epicMandate(PARENT, [nativeChild(nativeBody)], {
      recordId: 'ambiguous-parent-b',
      runId: 'parent05',
      operationId: 'op-parent-b',
      body: nativeBody,
      ownSpec: landingFixtures.ownSpecFromSnapshot(PARENT, nativeSnapshot(PARENT, nativeBody)),
    })
    const childWithParent = must(
      parseRecord({
        ...child,
        payload: {
          ...child.payload,
          parent: landingFixtures.mandateRef(first),
          inheritedOwnSpecRefs: [
            {
              uw: PARENT,
              version: first.payload.ownSpec.version,
              sourceAccepted: landingFixtures.mandateRef(first),
            },
          ],
        },
      }),
    )
    const childHistory = history([childWithParent])
    const parentHistory = history([first, second], PARENT)
    const causal = await parentWorld(childHistory, parentHistory, nativeBody)

    expect(resolveOwnSpecAuthority(childHistory, [parentHistory], causal)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'ambiguous' })],
    })
  })
})
