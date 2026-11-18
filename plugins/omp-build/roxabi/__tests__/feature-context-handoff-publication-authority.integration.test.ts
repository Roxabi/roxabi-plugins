import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Contracts from '../../dist/contracts.js'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { recordsOf } from '../../engine/workflow-control.ts'
import { fictionalUnavailableEffectViews } from '../../testing/context-effect-review-fixture.ts'
import {
  countCommentPosts,
  gateSuccessorConfigReads,
} from '../../testing/feature-context-handoff-publication-authority.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { ContextHandoffObservation } from '../feature-context-handoff-observation.ts'
import type { Contracts as EngineContracts, History } from '../feature-engine.ts'
import { type ContextHandoffPublication, publishSuccessorMandate, readSuccessionBasis } from '../feature-succession.ts'
import { publishAndRefreshSuccessor } from '../feature-succession-refresh.ts'
import { bindContextSuccessionOperator } from '../uw-context-succession-operation.ts'
import type { OperatorPort, UwOperations } from '../uw-contract.ts'
import { abandonedLeaf, branch, head, scope } from './uw-successor-selection-support.ts'

const workflow = roxabiWorkflowFixtures()

vi.mock('../../dist/contracts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Contracts>()
  return {
    ...actual,
    validateContextSuccessionProposal: vi.fn(() => ({
      ok: true as const,
      value: {
        negativeLeaf: { payload: { phase: 'result', action: 'implement' } },
        replacementAccepted: { uw: scope, version: 'v', sourceAccepted: { scope, kind: 'mandate', recordId: 'x' } },
        disposedStartKeys: new Set<string>(),
        baselineCode: {
          repository: scope.repository,
          base: head,
          head,
          referenceCommit: head,
        },
      },
    })),
    admitContextSuccession: vi.fn(() => ({ ok: true as const, value: {} })),
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

const confirmed: OperatorPort = {
  async executeConfirmed(prepared, action) {
    return {
      status: 'confirmed',
      value: await action({
        route: 'omp-native-command',
        operationId: prepared.proposal.operationId,
        proposalDigest: prepared.digest,
        confirmedAt: '2026-11-18T00:00:00.000Z',
      }),
    }
  },
}

function handoffObservation(negative: Extract<CanonicalRecord, { kind: 'action-receipt' }>): ContextHandoffObservation {
  const negativeRecordId = negative.recordId
  const payload = negative.payload
  const effects = fictionalUnavailableEffectViews({
    scope,
    negativeRecordId,
    payload,
    reason: 'Synthetic handoff publication-authority fixture; not absence-of-effects proof.',
  })
  return {
    negative: effects.negative,
    replacementAccepted: {
      uw: scope,
      version: 'b'.repeat(64),
      sourceAccepted: { scope, kind: 'mandate' as const, recordId: 'mandate-original' },
    },
    effectReports: effects.effectReports,
    histories: [],
    reconciliation: {
      kind: 'unchanged-delivery-baseline' as const,
      scope: 'workflow-owned-delivery-state' as const,
      code: {
        repository: scope.repository,
        base: head,
        head,
        referenceCommit: head,
      },
      repository: scope.repository,
      branch,
      status: { code: 0, stdout: '' },
      remote: {
        base: { ref: 'refs/heads/main', tip: head },
        candidate: { ref: `refs/heads/${branch}`, tip: null },
      },
      delivery: { uw: scope, pullRequests: [], integrations: [], commits: [] },
      cuts: [{ scope, count: 0, last: null }],
      historyDigest: 'f'.repeat(64),
      bindingDigest: 'a'.repeat(64),
      effectReview: effects.effectReview,
    },
  }
}

/** Seed start+rejected implement into abandoned tip so select-successor can bind same-scope negative. */
async function abandonedLeafWithConservedNegative() {
  let negative: Extract<CanonicalRecord, { kind: 'action-receipt' }> | undefined
  const subject = await abandonedLeaf((world) => {
    const start = workflow.implementStart(world.original)
    const result = workflow.rejectedImplementResult(world.original)
    world.seed(start)
    world.seed(result)
    if (result.kind !== 'action-receipt') throw new Error('conserved negative unavailable')
    negative = result
  })
  if (negative === undefined) throw new Error('conserved negative unavailable')
  return { subject, negative }
}

function publication(
  observed: ContextHandoffObservation,
  operations: UwOperations,
  canPublish: () => boolean,
): ContextHandoffPublication {
  return {
    operations,
    observed,
    canPublish,
    observe: async () => ({ ok: true as const, value: observed }),
  }
}

async function freshHome(
  loaded: EngineContracts,
  history: History,
  gh: (cwd: string, args: string[]) => Promise<string>,
  cwd: string,
) {
  const read = await loaded.readComposedWorkflowHistory([scope], {
    cwd,
    gh,
    readAuthor: history.source.expectedAuthor,
    ...(history.source.stopAuthor === null ? {} : { stopAuthor: history.source.stopAuthor }),
  })
  if (!read.ok || read.histories[0] === undefined) throw new Error('fresh history unavailable')
  return read.histories[0]
}

function completedSelectSuccessors(home: History) {
  return home.operations.flatMap((operation) =>
    operation.status === 'complete' &&
    operation.authority !== 'foreign' &&
    operation.record?.kind === 'operator-control' &&
    operation.record.payload.control === 'select-successor'
      ? [operation.record]
      : [],
  )
}

describe('context handoff publication live authority', () => {
  it('forwards canPublish into the real writer for successor mandate publication', async () => {
    const subject = await abandonedLeaf()
    const history = subject.before.histories.find((item) => item.source.scope.target === scope.target)
    if (history === undefined) throw new Error('abandoned history missing')
    const basis = readSuccessionBasis(history, subject.before.histories, true)
    if (!basis.ok) throw new Error('basis unavailable')
    let live = true
    const posts = countCommentPosts(subject.authority.context.gh)
    const gh = async (cwd: string, args: string[]) => {
      if (String(args[1] ?? '').includes('/comments') && !args.includes('POST')) {
        await Promise.resolve()
        live = false
      }
      return posts.gh(cwd, args)
    }
    const published = await publishAndRefreshSuccessor(
      {
        loaded: subject.engine,
        history,
        scope,
        cwd: subject.authority.context.cwd,
        gh,
        parents: [],
      },
      'successor-mandate-revoked',
      {
        ...basis.value.terminal.mandate.payload,
        antecedent: basis.value.terminal.ref,
        lineageHead: head,
      },
      () => live,
    )
    expect(published.ok).toBe(false)
    expect(posts.posts()).toBe(0)
    expect(live).toBe(false)
  })

  it('refuses premandate publication when ownership ends during post-observation config read', async () => {
    const { subject, negative } = await abandonedLeafWithConservedNegative()
    const history = subject.before.histories.find((item) => item.source.scope.target === scope.target)
    if (history === undefined) throw new Error('abandoned history missing')
    const basis = readSuccessionBasis(history, subject.before.histories, true)
    if (!basis.ok) throw new Error('basis unavailable')
    let live = true
    const observed = handoffObservation(negative)
    observed.histories = subject.before.histories
    const operations = {} as UwOperations
    bindContextSuccessionOperator(operations, confirmed)
    const posts = countCommentPosts(subject.authority.context.gh)
    const gated = gateSuccessorConfigReads(subject.authority.context.git, 2)
    const pending = publishSuccessorMandate({
      loaded: subject.engine,
      history,
      scope,
      basis: basis.value,
      ownSpec: basis.value.terminal.mandate.payload.ownSpec,
      tier: basis.value.terminal.mandate.payload.tier,
      children: basis.value.terminal.mandate.payload.children,
      inheritedOwnSpecRefs: basis.value.terminal.mandate.payload.inheritedOwnSpecRefs,
      coverage: basis.value.terminal.mandate.payload.coverage,
      git: gated.git,
      gh: posts.gh,
      cwd: subject.authority.context.cwd,
      parents: [],
      target: { kind: 'branch', branch },
      observedPullRequests: [],
      contextHandoff: publication(observed, operations, () => live),
    })
    await gated.entered
    live = false
    gated.release()
    const result = await pending
    expect(result).toMatchObject({ ok: false })
    expect(String(result.ok === false ? result.reason : '')).toMatch(/context-handoff-refused:premandate-config/)
    expect(posts.posts()).toBe(0)
    const home = await freshHome(subject.engine, history, posts.gh, subject.authority.context.cwd)
    expect(completedSelectSuccessors(home)).toEqual([])
  })

  it('keeps a partial mandate without selecting when ownership ends before selection config', async () => {
    const { subject, negative } = await abandonedLeafWithConservedNegative()
    const history = subject.before.histories.find((item) => item.source.scope.target === scope.target)
    if (history === undefined) throw new Error('abandoned history missing')
    const basis = readSuccessionBasis(history, subject.before.histories, true)
    if (!basis.ok) throw new Error('basis unavailable')
    let live = true
    const observed = handoffObservation(negative)
    observed.histories = subject.before.histories
    const operations = {} as UwOperations
    bindContextSuccessionOperator(operations, confirmed)
    const posts = countCommentPosts(subject.authority.context.gh)
    const gated = gateSuccessorConfigReads(subject.authority.context.git, 3)
    const pending = publishSuccessorMandate({
      loaded: subject.engine,
      history,
      scope,
      basis: basis.value,
      ownSpec: basis.value.terminal.mandate.payload.ownSpec,
      tier: basis.value.terminal.mandate.payload.tier,
      children: basis.value.terminal.mandate.payload.children,
      inheritedOwnSpecRefs: basis.value.terminal.mandate.payload.inheritedOwnSpecRefs,
      coverage: basis.value.terminal.mandate.payload.coverage,
      git: gated.git,
      gh: posts.gh,
      cwd: subject.authority.context.cwd,
      parents: [],
      target: { kind: 'branch', branch },
      observedPullRequests: [],
      contextHandoff: publication(observed, operations, () => live),
    })
    await gated.entered
    const postsBeforeRevoke = posts.posts()
    live = false
    gated.release()
    const result = await pending
    expect(result).toMatchObject({ ok: false })
    expect(String(result.ok === false ? result.reason : '')).toMatch(/context-handoff-partial:preselection-config/)
    expect(posts.posts()).toBe(postsBeforeRevoke)
    const home = await freshHome(subject.engine, history, posts.gh, subject.authority.context.cwd)
    expect(completedSelectSuccessors(home)).toEqual([])
  })

  it('publishes when the original live owner remains unchanged', async () => {
    const { subject, negative } = await abandonedLeafWithConservedNegative()
    const history = subject.before.histories.find((item) => item.source.scope.target === scope.target)
    if (history === undefined) throw new Error('abandoned history missing')
    const basis = readSuccessionBasis(history, subject.before.histories, true)
    if (!basis.ok) throw new Error('basis unavailable')
    const priorBodies = subject.native.comments.get(41)?.map((comment) => comment.body) ?? []
    const observed = handoffObservation(negative)
    observed.histories = subject.before.histories
    const operations = {} as UwOperations
    bindContextSuccessionOperator(operations, confirmed)
    const posts = countCommentPosts(subject.authority.context.gh)
    const result = await publishSuccessorMandate({
      loaded: subject.engine,
      history,
      scope,
      basis: basis.value,
      ownSpec: basis.value.terminal.mandate.payload.ownSpec,
      tier: basis.value.terminal.mandate.payload.tier,
      children: basis.value.terminal.mandate.payload.children,
      inheritedOwnSpecRefs: basis.value.terminal.mandate.payload.inheritedOwnSpecRefs,
      coverage: basis.value.terminal.mandate.payload.coverage,
      git: subject.authority.context.git,
      gh: posts.gh,
      cwd: subject.authority.context.cwd,
      parents: [],
      target: { kind: 'branch', branch },
      observedPullRequests: [],
      contextHandoff: publication(observed, operations, () => true),
    })
    expect(result).toEqual({ ok: true })
    expect(posts.posts()).toBeGreaterThan(0)
    const home = await freshHome(subject.engine, history, posts.gh, subject.authority.context.cwd)
    const selections = completedSelectSuccessors(home)
    expect(selections).toHaveLength(1)
    const selection = selections[0]
    if (selection === undefined || selection.payload.control !== 'select-successor') {
      throw new Error('completed select-successor unavailable')
    }
    const successor = selection.payload.successor
    expect(selection.payload.predecessor).toEqual({
      scope,
      recordId: 'mandate-original',
      kind: 'mandate',
    })
    expect(selection.payload.contextDisposition?.negative.record).toEqual({
      scope,
      kind: 'action-receipt',
      recordId: negative.recordId,
    })
    expect(recordsOf(home).some((record) => record.kind === 'mandate' && record.recordId === successor.recordId)).toBe(
      true,
    )
    expect(home.source.comments.slice(0, priorBodies.length).map((comment) => comment.body)).toEqual(priorBodies)
  })
})
