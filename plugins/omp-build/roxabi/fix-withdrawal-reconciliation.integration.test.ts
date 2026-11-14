import { describe, expect, it } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import type { Gh } from '../adapters/github/types.ts'
import { parseIssueSpecBody, rawSource } from '../adapters/github-native/uw-spec.ts'
import { readNativePullRequestFacts } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ObservedComment } from '../engine/review-schema.ts'
import type { WithdrawalBarrier } from '../skills/feature/workflow-gate.js'
import { standaloneReviewInputs } from '../testing/action-input-fixtures.ts'
import { graphFromSimulatedIssues } from '../testing/criterion-dispositions.ts'
import { sisterSpecWorld } from '../testing/multi-sister-spec-fixture.ts'
import { withNativeImplementationWorld } from '../testing/native-implementation-world.ts'
import { observedComment } from '../testing/record-history.ts'
import { roxabiRecordFixtures } from '../testing/roxabi-presets.ts'
import { readDecodedHistory } from './feature-context.ts'
import { resolveFeatureAuthority } from './feature-continuation-admission.ts'
import { readFeatureObservation } from './feature-continuation-observation.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import type { FeatureObservation } from './feature-observation-contract.ts'
import { reconcileWithdrawalHistories } from './fix-uw-histories.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'
import { createInstalledUwReadPort } from './uw-read-port.ts'
import { readSelectionIssueSpec } from './uw-spec'

const scope = { repository: 'acme/app', target: 'acme/app#42' }
const otherScope = { repository: 'acme/app', target: 'acme/app#43' }

function barrier(id: number, previous: number | null = null): WithdrawalBarrier {
  const record = {
    version: 1,
    kind: 'withdraw',
    operationId: `withdraw-${id}`,
    repositoryId: 100,
    pullRequestId: 200,
    pullRequest: 42,
    headSha: 'a'.repeat(40),
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    lane: 'all',
    source: 'revoke',
    previous,
    evidence: 'stop',
  }
  return {
    id,
    body: `<!-- kit-head-authorization:v1 -->\n${JSON.stringify(record)}`,
    createdAt: `2026-10-21T10:00:${id === 901 ? '01' : '02'}Z`,
    record,
  }
}

function comment(receipt: WithdrawalBarrier): ObservedComment {
  return observedComment({
    locator: `comment-${receipt.id}`,
    nativeId: String(receipt.id),
    body: receipt.body,
    createdAt: receipt.createdAt,
  })
}

function fixture() {
  const original = roxabiRecordFixtures().encodedAdmissionReviewGraph({ scope }).history
  const other = decodeHistory({ ...original.source, scope: otherScope, comments: [] })
  return { original, other }
}

function appended(history: DecodedHistory, comments: ObservedComment[]): DecodedHistory {
  return decodeHistory({ ...history.source, comments: [...history.source.comments, ...comments] })
}

function compare(before: DecodedHistory[], after: DecodedHistory[], barriers: WithdrawalBarrier[]) {
  return reconcileWithdrawalHistories(before, after, scope, barriers)
}

describe('withdrawal receipt reconciliation', () => {
  it('retains the fresh native history after exactly the confirmed own append', () => {
    const { original, other } = fixture()
    const receipt = barrier(901)
    const fresh = appended(original, [comment(receipt)])
    const result = compare([original, other], [fresh, other], [receipt])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual([fresh, other])
  })

  it('reconciles sequential distinct confirmed writes only in observed publication order', () => {
    const { original, other } = fixture()
    const first = barrier(901)
    const second = barrier(902, 901)
    const fresh = appended(original, [comment(first), comment(second)])
    expect(compare([original, other], [fresh, other], [first, second]).ok).toBe(true)
    expect(compare([original, other], [fresh, other], [second, first]).ok).toBe(false)
    expect(
      compare([original, other], [appended(original, [comment(second), comment(first)]), other], [first, second]).ok,
    ).toBe(false)
  })

  it.each(['id', 'body', 'createdAt', 'kind', 'pullRequest'] as const)(
    'refuses a receipt that does not authenticate the observed %s',
    (field) => {
      const { original, other } = fixture()
      const receipt = barrier(901)
      const fresh = appended(original, [comment(receipt)])
      const wrong: WithdrawalBarrier =
        field === 'id'
          ? { ...receipt, id: 999 }
          : field === 'body'
            ? { ...receipt, body: `${receipt.body} ` }
            : field === 'createdAt'
              ? { ...receipt, createdAt: '2026-10-21T10:01:01Z' }
              : { ...receipt, record: { ...receipt.record, [field]: field === 'kind' ? 'grant' : 43 } }
      expect(compare([original, other], [fresh, other], [wrong]).ok).toBe(false)
    },
  )

  it('refuses missing or unconfirmed receipts, including protocol-shaped foreign comments', () => {
    const { original, other } = fixture()
    const own = barrier(901)
    const foreign = barrier(902)
    expect(compare([original, other], [original, other], [own]).ok).toBe(false)
    expect(compare([original, other], [appended(original, [comment(own)]), other], []).ok).toBe(false)
    expect(compare([original, other], [appended(original, [comment(foreign)]), other], [own]).ok).toBe(false)
    expect(compare([original, other], [appended(original, [comment(own), comment(foreign)]), other], [own]).ok).toBe(
      false,
    )
    expect(compare([original, other], [appended(original, [comment(foreign), comment(own)]), other], [own]).ok).toBe(
      false,
    )
  })

  it('refuses edits, deletion, and native identity changes to preceding comments', () => {
    const { original, other } = fixture()
    const receipt = barrier(901)
    const prior = original.source.comments[0]
    if (!prior) throw new Error('expected native review comment')
    for (const changed of [
      { ...prior, body: `${prior.body} edited` },
      { ...prior, nativeId: '999' },
      { ...prior, locator: 'different-native-locator' },
    ]) {
      const altered = {
        ...original,
        source: { ...original.source, comments: [changed, ...original.source.comments.slice(1)] },
      }
      expect(compare([original, other], [appended(altered, [comment(receipt)]), other], [receipt]).ok).toBe(false)
    }
    const deleted = { ...original, source: { ...original.source, comments: original.source.comments.slice(1) } }
    expect(compare([original, other], [appended(deleted, [comment(receipt)]), other], [receipt]).ok).toBe(false)
  })

  it('refuses drift in other scopes, decoded evidence, completeness, or scope membership', () => {
    const { original, other } = fixture()
    const receipt = barrier(901)
    const fresh = appended(original, [comment(receipt)])
    const changedOperations = { ...fresh, operations: fresh.operations.slice(1) }
    expect(compare([original, other], [changedOperations, other], [receipt]).ok).toBe(false)
    const changedEvidence = {
      ...fresh,
      diagnostics: [...fresh.diagnostics, { code: 'changed', message: 'new evidence' }],
    }
    const changedOther = { ...other, source: { ...other.source, comments: [observedComment()] } }
    const incomplete = { ...fresh, source: { ...fresh.source, complete: false } }
    expect(compare([original, other], [changedEvidence, other], [receipt]).ok).toBe(false)
    expect(compare([original, other], [fresh, changedOther], [receipt]).ok).toBe(false)
    expect(compare([original, other], [incomplete, other], [receipt]).ok).toBe(false)
    expect(compare([original, other], [fresh], [receipt]).ok).toBe(false)
    expect(compare([original, other], [fresh, fresh], [receipt]).ok).toBe(false)
    expect(compare([other], [other], [receipt]).ok).toBe(false)
  })
})

/** Supply declared failing CI at the provider boundary while retaining native withdrawal writes. */
function failingCiTransport(nativeGh: (cwd: string, args: string[]) => Promise<string>, onWithdrawal: () => void) {
  return async (cwd: string, args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('statusCheckRollup'))
      return JSON.stringify({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] })
    if (args[1] === 'graphql' && args.some((arg) => arg.includes('statusCheckRollup')))
      return JSON.stringify({
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: 'CheckRun',
                      id: 'check-1',
                      name: 'test',
                      status: 'COMPLETED',
                      conclusion: 'FAILURE',
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      })
    const result = await nativeGh(cwd, args)
    if (
      args.includes('POST') &&
      args.some((arg) => arg.startsWith('body=<!-- kit-head-authorization:v1 -->') && arg.includes('"kind":"withdraw"'))
    )
      onWithdrawal()
    return result
  }
}

function assertWithdrawalOutcome(
  drift: 'none' | 'tier' | 'label',
  result: FeatureObservation | ContinueFeatureResult,
  before: UwRead,
  pullRequest: { repository: string; target: string },
): void {
  if (drift !== 'none') {
    expect(result).toMatchObject({ kind: 'blocked' })
    return
  }
  expect('kind' in result).toBe(false)
  if ('kind' in result) throw new Error(`unexpected continuation: ${JSON.stringify(result)}`)
  expect(result.evidence.causal.observation).not.toBe(before.observation)
  expect(result.evidence.causal.histories).toBe(result.evidence.causal.observation.histories)
  expect(result.evidence.causal.catalogues).toBe(result.evidence.causal.observation.catalogues)
  const fresh = result.evidence.causal.histories.find((history) => history.source.scope.target === pullRequest.target)
  expect(fresh?.source.comments.some((item) => item.body.includes('"kind":"withdraw"'))).toBe(true)
}

/** Verify the native sibling's accepted Spec/tier and delivery coordinates independently of the fence. */
function assertLabelOnlyDrift(before: UwRead, after: UwRead): void {
  expect(before.accepted.status).toBe('accepted')
  expect(after.accepted).toEqual(before.accepted)
  expect(before.parsed.status).toBe('conformant')
  expect(after.parsed).toEqual(before.parsed)
  const oldNode = before.graph.nodes.find((node) => node.uw.target === before.uw.target)
  const newNode = after.graph.nodes.find((node) => node.uw.target === before.uw.target)
  if (!oldNode || !newNode) throw new Error('sibling native node missing')
  expect(oldNode.labels.filter((label) => label.startsWith('size:'))).toEqual(['size:S'])
  expect(newNode.labels.filter((label) => label.startsWith('size:'))).toEqual(['size:S'])
  expect(newNode.labels).toEqual([...oldNode.labels, 'fixture:unrelated'])
}

async function assertWithdrawalNativeFacts(input: {
  gh: Gh
  cwd: string
  pr: { repository: string; target: string }
  sibling: { repository: string; target: string }
  reader: UwReadPort
  siblingBefore: UwRead
  beforePull: unknown
  beforeHistory: DecodedHistory
  drift: 'none' | 'tier' | 'label'
}): Promise<void> {
  const afterHistory = await readDecodedHistory(input.pr, input.cwd, input.gh)
  if (!afterHistory.ok) throw new Error('native PR history unavailable')
  const oldComments = input.beforeHistory.source.comments
  const currentComments = afterHistory.history.source.comments
  expect(currentComments.slice(0, oldComments.length)).toEqual(oldComments)
  expect(currentComments.slice(oldComments.length).some((item) => item.body.includes('"kind":"withdraw"'))).toBe(true)
  if (input.drift === 'label') {
    assertLabelOnlyDrift(input.siblingBefore, await input.reader.readUw(input.sibling))
    expect(await readNativePullRequestFacts(input.pr.repository, 44, { cwd: input.cwd, gh: input.gh })).toEqual(
      input.beforePull,
    )
  }
}

async function selectedWithdrawalAuthority(input: {
  cwd: string
  git: NonNullable<ContinueFeatureInput['git']>
  gh: Gh
  reader: UwReadPort
  before: UwRead
  uw: typeof scope
}): Promise<SelectedFeature> {
  if (input.before.observation.status !== 'complete') throw new Error('incomplete initial observation')
  const primary = input.before.histories.find((history) => history.source.scope.target === input.uw.target)
  if (!primary) throw new Error('missing native issue history')
  const authority = await resolveFeatureAuthority({
    cwd: input.cwd,
    reference: '#44',
    control: 'continue',
    principal: true,
    gh: input.gh,
    git: input.git,
    read: input.reader,
  })
  if ('kind' in authority) throw new Error(`fixture authority refused: ${JSON.stringify(authority)}`)
  const ownSpec = authority.context.engine.resolveOwnSpecAuthority(
    authority.history,
    authority.parentHistories,
    authority.causal,
  )
  if (!ownSpec.ok) throw new Error(`fixture own Spec unavailable: ${JSON.stringify(ownSpec.diagnostics)}`)
  const issue = await readSelectionIssueSpec(input.cwd, input.uw.repository, 42, input.gh)
  if (issue === null) throw new Error('fixture issue unavailable')
  return {
    authority,
    number: 44,
    reader: input.reader,
    uwRead: input.before,
    mandate: ownSpec.value.mandate,
    acceptedSpec: ownSpec.value.accepted,
    mandateRef: { scope: input.uw, recordId: ownSpec.value.mandate.recordId, kind: 'mandate' },
    issue,
    mandatePublished: false,
  }
}

describe('complete observation refresh after native withdrawal', () => {
  it.each(['none', 'tier', 'label'] as const)(
    'reconciles a real post-withdrawal cut; sibling drift=%s',
    async (drift) => {
      const fixture = sisterSpecWorld(false)
      const { fixtures, uw, pr, mandate, body } = fixture
      const own = fixtures.historyFrom([mandate], 'roxabi-bot')
      const parent = { repository: uw.repository, target: 'acme/app#41' }
      const sibling = { repository: uw.repository, target: 'acme/app#43' }
      const parsedSibling = parseIssueSpecBody({
        uw: sibling,
        raw: rawSource(sibling.target, body, '2026-10-27T12:00:00Z'),
      })
      if (parsedSibling.status !== 'conformant') throw new Error('sibling Spec is not conformant')
      const siblingMandate = fixtures.featureMandate(sibling, {
        recordId: 'mandate-43',
        operationId: 'mandate-operation-43',
        body,
        ownSpec: fixtures.ownSpecFromSnapshot(sibling, parsedSibling.snapshot),
      })
      const siblingHistory = fixtures.historyFrom([siblingMandate], 'roxabi-bot')
      const head = '1'.repeat(40)
      const base = '2'.repeat(40)
      const inputs = standaloneReviewInputs(pr, head)
      const review = roxabiRecordFixtures().encodedAdmissionReviewGraph({ scope: pr, head, inputs })
      const binding = fixtures.workflowBinding(pr, mandate, 'feat/42-save', 'main')
      const bindingHistory = fixtures.historyFrom([binding], 'roxabi-bot', 'roxabi-bot', [own])
      const pullHistory = decodeHistory({
        ...bindingHistory.source,
        comments: [...bindingHistory.source.comments, ...review.comments],
      })
      const empty = (target: typeof parent) => decodeHistory({ ...own.source, scope: target, comments: [] })
      const issue = (number: number, issueBody: string, labels: string[], subIssues: number[]) => ({
        number,
        title: `Issue ${number}`,
        body: issueBody,
        labels,
        subIssues,
        blockedBy: [],
        updatedAt: '2026-10-27T12:00:00Z',
        state: 'OPEN',
        stateReason: null,
      })
      const graph = (labels: string[]) =>
        graphFromSimulatedIssues(uw, [
          issue(41, '', ['size:F-lite'], [42, 43]),
          issue(42, body, ['size:S'], []),
          issue(43, body, labels, []),
        ])
      const commit = (sha: string, parents: string[]) => ({
        sha,
        parents,
        tree: '3'.repeat(40),
        subject: 'fixture',
        paths: [],
        config: null,
      })
      const afterGraph = {
        none: null,
        tier: graph(['size:M']),
        label: graph(['size:S', 'fixture:unrelated']),
      }[drift]
      await withNativeImplementationWorld(
        {
          anchor: uw,
          plugin: inputs.manifest.plugin,
          author: 'roxabi-bot',
          graph: graph(['size:S']),
          histories: [own, empty(parent), siblingHistory, pullHistory],
          commits: [commit(base, []), commit(head, [base])],
          comparisons: [{ base, head, status: 'ahead', commits: [head] }],
          diffs: [],
          checkout: { branch: 'feat/42-save', head, base: 'main', baseTip: base, remoteTip: head },
          authorization: { repositoryId: 100, operatorId: 101, appId: 102, botUserId: 103 },
          pullRequests: [
            {
              scope: pr,
              branch: 'feat/42-save',
              base: 'main',
              head,
              baseTip: base,
              state: 'OPEN',
              mergeCommit: null,
              author: 'roxabi-bot',
              gate: { labels: [], autoMerge: null },
            },
          ],
        },
        async (world) => {
          let withdrawals = 0
          const gh = failingCiTransport(world.gh, () => {
            withdrawals += 1
            if (afterGraph !== null) world.observeGraph(afterGraph)
          })
          const reader = createInstalledUwReadPort({ cwd: world.cwd, gh, readAuthor: 'roxabi-bot' })
          const siblingBefore = await reader.readUw(sibling)
          const beforePull = await readNativePullRequestFacts(pr.repository, 44, { cwd: world.cwd, gh })
          const beforeHistory = await readDecodedHistory(pr, world.cwd, gh)
          if (!beforeHistory.ok) throw new Error('native PR history unavailable')
          const before = await reader.readUw(uw)
          const selected = await selectedWithdrawalAuthority({
            cwd: world.cwd,
            git: world.git,
            gh,
            reader,
            before,
            uw,
          })
          const previous = JSON.stringify(before.observation)
          const result = await readFeatureObservation('resume', selected)
          expect(withdrawals).toBeGreaterThan(0)
          expect(JSON.stringify(before.observation)).toBe(previous)
          await assertWithdrawalNativeFacts({
            gh,
            cwd: world.cwd,
            pr,
            sibling,
            reader,
            siblingBefore,
            beforePull,
            beforeHistory: beforeHistory.history,
            drift,
          })
          assertWithdrawalOutcome(drift, result, before, pr)
        },
      )
    },
  )
})
