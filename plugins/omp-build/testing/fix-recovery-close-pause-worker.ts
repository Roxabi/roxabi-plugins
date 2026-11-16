import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { encodeParts } from '../adapters/github/history-encoder.ts'
import { pauseControls } from '../engine/__tests__/workflow-test-support.ts'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { prepareFixRecoveryClose } from '../engine/fix-recovery-close.ts'
import { makeFixRecoveryObservation } from '../engine/fix-recovery-observation.ts'
import { commentAsPartPin } from '../engine/fix-recovery-part-pins.ts'
import type { DecodedHistory, OperationRead } from '../engine/history-schema.ts'
import { createOperatorConfirmation } from '../omp/omp-operator-confirmation.ts'
import {
  acquireDestinationAdmissionLease,
  releaseDestinationAdmissionLease,
} from '../omp/review-runtime/destination-admission-lease.ts'
import { observeCurrentLinuxHost } from '../omp/review-runtime/linux-execution-lease.ts'
import { executeFixRecoveryClose } from '../roxabi/fix-recovery-close-execution.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { arrangeReviewFixture, seedReviewFixture } from './feature-review-fixture.ts'
import { seedFixRecoveryPrefix } from './fix-recovery-prefix-fixture.ts'
import { operatorDialogUi } from './operator-dialog-ui.ts'
import { git, readSim, writeSim } from './sandbox/sandbox-repository.ts'

function pin<K extends 'mandate' | 'workflow-binding'>(history: DecodedHistory, operation: OperationRead, kind: K) {
  const record = operation.record
  if (operation.status !== 'complete' || record?.kind !== kind) throw new Error(`fixture-${kind}-missing`)
  const parts = operation.parts
    .map((part) => {
      const value = commentAsPartPin(part)
      if (!value) throw new Error(`fixture-${kind}-unpinnable`)
      return value
    })
    .sort((a, b) => a.part - b.part)
  return {
    identity: {
      scope: history.source.scope,
      kind,
      runId: record.runId,
      operationId: record.operationId,
      recordId: record.recordId,
    },
    envelopeDigest: canonicalValueDigest(record),
    parts,
  }
}

const timing = process.argv[2]
if (timing !== 'before-entry' && timing !== 'during-confirmation') throw new Error('invalid-pause-timing')
const { box, cwd } = arrangeReviewFixture()
try {
  await seedReviewFixture(box, cwd)
  // Structural history exercises closure, not native originating-owner qualification.
  const authority = readSim(box).repositoryAuthority
  if (!authority) throw new Error('fixture-authority-missing')
  const host = await observeCurrentLinuxHost()
  if (host.status !== 'qualified') throw new Error(`host-unqualified:${JSON.stringify(host)}`)
  const fixture = await seedFixRecoveryPrefix(box, cwd, 'torn-request', { authority, host })
  const gh = async (dir: string, args: string[]) =>
    execFileSync(path.join(box.root, 'bin', 'gh'), args, {
      cwd: dir,
      env: box.env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }).trim()
  const reader = createInstalledUwReadPort({ cwd, gh, readAuthor: 'operator' })
  const initial = await reader.readUw(fixture.uw)
  const issue = initial.histories.find((history) => history.source.scope.target === fixture.uw.target)
  const pr = initial.histories.find((history) => history.source.scope.target === fixture.pullRequest.target)
  if (!issue || !pr) throw new Error('fixture-history-missing')
  const mandate = issue.operations.find((item) => item.record?.kind === 'mandate')
  const binding = pr.operations.find((item) => item.record?.kind === 'workflow-binding')
  const owner = issue.operations.find(
    (item) => item.record?.kind === 'fix-owner' && item.record.payload.phase === 'opened',
  )?.record
  const settled = issue.operations.find(
    (item) => item.record?.kind === 'fix-owner' && item.record.payload.phase === 'settled',
  )?.record
  if (
    mandate?.record?.kind !== 'mandate' ||
    binding?.record?.kind !== 'workflow-binding' ||
    owner?.kind !== 'fix-owner' ||
    owner.payload.phase !== 'opened' ||
    settled?.kind !== 'fix-owner' ||
    settled.payload.phase !== 'settled'
  )
    throw new Error('fixture-anchor-missing')
  const common = owner.payload.common
  const acquired = await acquireDestinationAdmissionLease({ destination: common.destination })
  if (acquired.status !== 'acquired') throw new Error(`lease-unavailable:${JSON.stringify(acquired)}`)
  try {
    const stdout = git(box, cwd, ['status', '--porcelain'])
    const current = {
      authority: {
        mandate: pin(issue, mandate, 'mandate'),
        binding: pin(pr, binding, 'workflow-binding'),
        plugin: common.plugin,
        configuration: common.configuration,
        accepted: common.accepted,
      },
      pullRequest: {
        scope: common.pullRequest,
        state: 'open' as const,
        candidateGitSHA: git(box, cwd, ['rev-parse', 'HEAD']),
        baseGitSHA: git(box, cwd, ['rev-parse', 'main']),
        headRepository: common.destination.publicationRepository,
        branch: binding.record.payload.branch,
        base: binding.record.payload.base,
        destination: common.destination,
      },
      local: { ...settled.payload.local, status: { format: 'git-status-porcelain-v1' as const, stdout } },
      host: {
        process: host.process,
        root: common.root,
        namespace: host.namespace,
        prior: { kind: 'sealed-drained-live' as const },
      },
    }
    const control = {
      scope: fixture.pullRequest,
      kind: 'fix-recovery' as const,
      runId: 'pause-test-run',
      operationId: 'pause-test-operation',
      recordId: 'pause-test-close',
    }
    const observation = makeFixRecoveryObservation({ histories: initial.histories, graph: initial.graph, current })
    if (!observation.ok) throw new Error(`fixture-observation-invalid:${JSON.stringify(observation)}`)
    const eligible = prepareFixRecoveryClose({ control, observation: observation.value, histories: initial.histories })
    if (!eligible.ok) throw new Error(`fixture-not-eligible:${JSON.stringify(eligible)}`)
    assert.equal(eligible.value.proposal.phase, 'close-publication')
    assert.deepEqual(eligible.value.proposal.opened, fixture.opened)
    assert.deepEqual(eligible.value.proposal.settled, fixture.settled)
    const before = readSim(box)
    const originalIssue = before.issues['42']?.comments.map((item) => item.body) ?? []
    const originalPr = before.prs['7']?.comments.map((item) => item.body) ?? []
    const controls = pauseControls(mandate.record, 'host-close-pause')
    const appendPause = () => {
      const encoded = encodeParts(controls.requested, '', 65536)
      if (!encoded.ok) throw new Error('pause-encoding-failed')
      writeSim(box, (state) => {
        const target = state.issues['42']
        if (!target) throw new Error('fixture-issue-missing')
        target.comments.push(
          ...encoded.value.map((body, index) => ({
            id: 80001 + index,
            author: 'operator',
            body,
            createdAt: fixture.date,
            updatedAt: fixture.date,
          })),
        )
      })
    }
    let confirmations = 0
    const context = {
      agent: { kind: 'main', depth: 0, id: 'Main' },
      hasUI: true,
      mode: 'tui',
      cwd,
      ui: operatorDialogUi(async () => {
        confirmations++
        if (timing === 'during-confirmation') appendPause()
        return 'confirm'
      }),
      localProtocolOptions: { getArtifactsDir: () => path.join(box.root, 'artifacts') },
      sessionManager: {
        getSessionId: () => 'pause-test-session',
        getCwd: () => cwd,
        getSessionFile: () => path.join(box.root, 'session.jsonl'),
        getArtifactsDir: () => path.join(box.root, 'artifacts'),
      },
    } as unknown as ExtensionContext
    if (timing === 'before-entry') appendPause()
    const result = await executeFixRecoveryClose({
      control,
      lease: acquired.lease,
      github: { cwd, gh, readAuthor: 'operator', writeAuthor: 'operator' },
      operator: createOperatorConfirmation(context),
      rootCurrent: () => true,
      readCurrent: async () => {
        const read = await reader.readUw(fixture.uw)
        return { ok: true, value: { histories: read.histories, graph: read.graph, current } }
      },
    })
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(confirmations, timing === 'before-entry' ? 0 : 1)
    const after = await reader.readUw(fixture.uw)
    const operations = after.histories.flatMap((history) => history.operations)
    assert.ok(
      operations.some(
        (operation) =>
          operation.status === 'complete' &&
          operation.record?.kind === 'operator-control' &&
          operation.record.recordId === controls.requested.recordId &&
          operation.record.payload.control === 'pause-requested',
      ),
    )
    assert.equal(after.fixRecovery.status, 'blocked')
    assert.ok(!operations.some((operation) => operation.record?.kind === 'fix-recovery'))
    const raw = readSim(box)
    const issueBodies = raw.issues['42']?.comments.map((item) => item.body) ?? []
    const prBodies = raw.prs['7']?.comments.map((item) => item.body) ?? []
    for (const body of originalIssue) assert.ok(issueBodies.includes(body))
    assert.deepEqual(prBodies, originalPr)
    for (const body of [...fixture.framedSource, fixture.framedRequest[0]]) assert.ok(prBodies.includes(body))
    const owners = operations
      .filter((operation) => operation.record?.kind === 'fix-owner')
      .map((operation) => operation.record?.recordId)
    assert.ok(owners.includes(fixture.opened.recordId))
    assert.ok(owners.includes(fixture.settled.recordId))
  } finally {
    const released = await releaseDestinationAdmissionLease(acquired.lease)
    assert.equal(released.status, 'released', JSON.stringify(released))
  }
} finally {
  rmSync(box.root, { recursive: true, force: true })
}
