import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHECKOUT_BASE,
  CHECKOUT_HEADS,
  readFixtureGit,
  WORKTREE,
} from '../../skills/feature/review-record-git-fixture.js'
import { TOOLING_COMMIT } from '../../skills/feature/review-record-pin.js'
import { standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { causeFixtureGraph } from '../../testing/cause-input-fixture.ts'
import { produceNativeImplementation } from '../../testing/native-implementation-producer.ts'
import { nativeCommitResponse, nativePullResponse } from '../../testing/native-implementation-transport-pulls.ts'
import { withNativeImplementationWorld } from '../../testing/native-implementation-world.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { canonicalValueDigest } from '../action-input.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { recordsOf } from '../workflow-control.ts'
import { lineageSeed } from './cause-lineage-fixture.ts'
import type { scenario } from './cause-same-pr-history-fixture.ts'
import { syncSamePrHistories } from './same-pr-criterion-fixture.ts'
import { captureSamePrPlan } from './same-pr-native-plan.ts'

/** One append-only native world backed by independently observed real Git commits. */
export async function withSamePrNativeWorld<T>(
  use: (data: {
    native: Parameters<typeof scenario>[2]
    world: Parameters<Parameters<typeof withNativeImplementationWorld>[1]>[0]
    produceEvidence: Parameters<typeof scenario>[2]['produce']
    heads: readonly string[]
    base: string
    nativeResponse: (args: string[]) => string | null
  }) => Promise<T>,
): Promise<T> {
  const seed = lineageSeed(TOOLING_COMMIT, CHECKOUT_BASE)
  const heads: string[] = [...CHECKOUT_HEADS]
  const [initialHead, secondHead] = heads
  const [initialHistory, parentHistory] = seed.histories
  if (
    initialHead === undefined ||
    secondHead === undefined ||
    initialHistory === undefined ||
    parentHistory === undefined
  )
    throw new Error('Expected initial candidate heads and parent history')
  const all = [CHECKOUT_BASE, ...heads]
  const git = (args: string[]) => readFixtureGit(args) as string
  const commits = all.map((sha) => ({
    sha,
    parents: git(['rev-list', '--parents', '-n1', sha]).split(/\s+/).slice(1),
    tree: git(['rev-parse', `${sha}^{tree}`]),
    subject: git(['show', '-s', '--format=%s', sha]),
    paths: git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean),
    config: null,
  }))
  const comparisons = all.flatMap((base, index) =>
    all.slice(index).map((head, offset) => ({
      base,
      head,
      status: offset === 0 ? ('identical' as const) : ('ahead' as const),
      commits: all.slice(index + 1, index + offset + 1),
    })),
  )
  const diffs = all.flatMap((base, index) =>
    all.slice(index + 1).map((head) => ({
      base,
      head,
      bytes: new Uint8Array(execFileSync('git', ['diff', '--no-ext-diff', base, head], { cwd: WORKTREE })),
    })),
  )
  const bytes = new Uint8Array(readFileSync(join(WORKTREE, 'first.txt')))
  const ref = {
    source: 'git-file' as const,
    repository: seed.context.original.repository,
    commit: initialHead,
    path: 'first.txt',
    digest: createHash('sha256').update(bytes).digest('hex'),
  }
  const pull = {
    scope: seed.graph.history.source.scope,
    branch: 'feat/42-save',
    base: 'main',
    head: CHECKOUT_BASE,
    baseTip: CHECKOUT_BASE,
    state: 'OPEN' as const,
    mergeCommit: null,
    author: 'operator',
  }
  const checkout = (head: string) => ({
    branch: pull.branch,
    head,
    base: pull.base,
    baseTip: CHECKOUT_BASE,
    remoteTip: head,
  })
  return withNativeImplementationWorld(
    {
      anchor: seed.context.original,
      checkout: checkout(CHECKOUT_BASE),
      commits,
      comparisons,
      diffs,
      plugin: standaloneReviewInputs().manifest.plugin,
      pullRequests: [pull],
      repositoryFiles: [{ ref, bytes }],
      author: 'operator',
      graph: causeFixtureGraph(seed.body),
      histories: [initialHistory, parentHistory],
    },
    async (world) => {
      let currentHead = CHECKOUT_BASE
      let plannedKey: string | null = null
      let currentPlanRecords: CanonicalRecord[] = []
      const updatePlan = async (context: Parameters<Parameters<typeof scenario>[2]['produce']>[0]) => {
        const observed = await world.operations.readUw(context.mandate.payload.ownSpec.uw)
        if (observed.observation.status !== 'complete' || observed.accepted.status !== 'accepted')
          throw new Error('Native planning requires a complete accepted observation')
        const key = canonicalValueDigest({
          mandate: {
            repository: context.mandate.repository,
            target: context.mandate.target,
            recordId: context.mandate.recordId,
          },
          effective: context.effective,
          sources: observed.accepted.value.sourceRefs,
        })
        if (key !== plannedKey) {
          const commit = commits.find((item) => item.sha === currentHead)
          if (!commit) throw new Error(`Undeclared plan commit ${currentHead}`)
          currentPlanRecords = await captureSamePrPlan({
            world,
            scope: context.mandate.payload.ownSpec.uw,
            mandate: context.mandate,
            effective: context.effective,
            commit: currentHead,
            tree: commit.tree,
          })
          plannedKey = key
        }
        return currentPlanRecords
      }
      const produce = async (context: Parameters<Parameters<typeof scenario>[2]['produce']>[0], evidence: boolean) => {
        if (!all.includes(context.head) || all.indexOf(context.head) <= all.indexOf(currentHead))
          throw new Error('Native implementation requires a declared descendant commit')
        world.observeGraph(causeFixtureGraph(context.nativeBody))
        await syncSamePrHistories(world.cwd, world.gh, context.histories)
        world.checkout(checkout(currentHead))
        const planRecords = await updatePlan(context)
        async function readPreflight() {
          const before = await world.operations.readUw(context.mandate.payload.ownSpec.uw)
          if (before.observation.status !== 'complete' || before.accepted.status !== 'accepted')
            throw new Error(
              `Native implementation preflight refused: ${JSON.stringify(
                {
                  observationStatus: before.observation.status,
                  observationDiagnostics:
                    before.observation.status === 'incomplete' ? before.observation.diagnostics : [],
                  accepted: before.accepted,
                  requested: {
                    scope: context.mandate.payload.ownSpec.uw,
                    nativeBodyDigest: canonicalValueDigest(context.nativeBody),
                    effective: context.effective,
                    currentHead,
                    candidateHead: context.head,
                    mandate: context.mandate.recordId,
                  },
                  parsed: before.parsed,
                  proposed: before.proposed,
                  identity: before.identity,
                  admission: before.admission,
                },
                null,
                2,
              )}`,
            )
          return before
        }
        const before = await readPreflight()
        const produced = await produceNativeImplementation({
          cwd: world.cwd,
          gh: world.gh,
          git: world.git,
          operations: world.operations,
          read: before,
          scope: context.mandate.payload.ownSpec.uw,
          mandate: context.mandate,
          parents: [],
          startHead: currentHead,
          command: 'bun test save',
          output: 'save test passed',
          ...(evidence
            ? {}
            : {
                criterion: {
                  verification: 'unverified' as const,
                  reason: 'The saved region requires independent verification',
                },
              }),
          advance() {
            world.checkout(checkout(context.head))
            world.observePullRequest({ ...pull, head: context.head })
            const commit = commits.find((item) => item.sha === context.head)
            if (commit === undefined) throw new Error(`Undeclared commit ${context.head}`)
            return { head: context.head, tree: commit.tree }
          },
        })
        currentHead = context.head
        const subject = acceptedPullRequestReviewGraph({ mandate: context.mandate, binding: context.binding }).inputs
          .manifest.subject
        const prepared = await world.operations.prepareAction({
          actionId: `${context.prefix}-root`,
          purpose: 'review',
          subject,
          code: {
            repository: context.mandate.repository,
            base: CHECKOUT_BASE,
            head: context.head,
            referenceCommit: context.head,
          },
          stageSources: [],
          expandedContext: [],
        })
        if (!prepared.ok) throw new Error(`Cannot prepare native review: ${JSON.stringify(prepared.diagnostics)}`)
        const start = recordsOf(produced.history).find(
          (record) =>
            record.recordId === produced.opened.start.recordId &&
            record.kind === 'action-receipt' &&
            record.payload.action === 'implement' &&
            record.payload.phase === 'start',
        )
        if (!start) throw new Error('Native readback lacks the implementation START')
        return {
          records: [...planRecords, start, produced.receipt],
          reviewInputs: prepared.value.inputs,
          history: produced.history,
        }
      }
      const native: Parameters<typeof scenario>[2] = {
        baseHead: CHECKOUT_BASE,
        initialHead,
        currentHead: secondHead,
        produce: (context) => produce(context, false),
      }
      const nativeResponse = (args: string[]) => {
        if (args[0] !== 'api') return null
        return (
          nativePullResponse(
            args,
            pull.scope.repository,
            new Map([[pull.scope.target, { ...pull, head: currentHead }]]),
          ) ??
          nativeCommitResponse(
            args,
            pull.scope.repository,
            new Map(commits.map((commit) => [commit.sha, commit])),
            new Map(comparisons.map((comparison) => [`${comparison.base}\0${comparison.head}`, comparison])),
          ) ??
          null
        )
      }
      return use({
        native,
        world,
        heads,
        base: CHECKOUT_BASE,
        nativeResponse,
        produceEvidence: (context) => produce(context, true),
      })
    },
  )
}
