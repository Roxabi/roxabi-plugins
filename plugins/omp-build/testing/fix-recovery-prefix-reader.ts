import { execFileSync } from 'node:child_process'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { buildConfirmedFixRecoveryClose, prepareFixRecoveryClose } from '../engine/fix-recovery-close.ts'
import { makeFixRecoveryObservation } from '../engine/fix-recovery-observation.ts'
import { commentAsPartPin } from '../engine/fix-recovery-part-pins.ts'
import type { DecodedHistory, OperationRead } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import { defaultGh } from '../roxabi/fix-entry-target-core.ts'
import type { UwRead } from '../roxabi/uw-contract.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'

function required<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.value
}

function pin<K extends 'mandate' | 'workflow-binding'>(history: DecodedHistory, operation: OperationRead, kind: K) {
  const record = operation.record
  if (operation.status !== 'complete' || record?.kind !== kind) throw new Error(`fixture-${kind}-missing`)
  const parts = operation.parts
    .map((part) => {
      const pin = commentAsPartPin(part)
      if (pin === null) throw new Error(`fixture-${kind}-unpinnable`)
      return pin
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

// A structural external-history confirmation, not a live native UI or host capability.
function buildFixtureControl(read: UwRead, cwd: string) {
  const histories = read.histories
  const issue = histories.find((history) => history.source.scope.target === 'acme/app#42')
  const pr = histories.find((history) => history.source.scope.target === 'acme/app#7')
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
    !mandate ||
    !binding ||
    binding.record?.kind !== 'workflow-binding' ||
    owner?.kind !== 'fix-owner' ||
    owner.payload.phase !== 'opened' ||
    settled?.kind !== 'fix-owner' ||
    settled.payload.phase !== 'settled'
  )
    throw new Error('fixture-anchor-missing')
  const common = owner.payload.common
  if (common.host.kind !== 'linux-qualified') throw new Error('fixture-host-not-qualified')
  const git = (args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  const stdout = git(['status', '--porcelain'])
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
      candidateGitSHA: git(['rev-parse', 'HEAD']).trim(),
      baseGitSHA: git(['rev-parse', 'main']).trim(),
      headRepository: common.destination.publicationRepository,
      branch: binding.record.payload.branch,
      base: binding.record.payload.base,
      destination: common.destination,
    },
    local: { ...settled.payload.local, status: { format: 'git-status-porcelain-v1' as const, stdout } },
    host: {
      process: common.host.process,
      root: common.root,
      namespace: common.host.namespace,
      prior: { kind: 'sealed-drained-live' as const },
    },
  }
  const observation = required(makeFixRecoveryObservation({ histories, graph: read.graph, current }))
  const control = {
    scope: common.pullRequest,
    kind: 'fix-recovery' as const,
    runId: 'recovery-fixture-run',
    operationId: 'recovery-fixture-operation',
    recordId: 'recovery-fixture-control',
  }
  const prepared = required(prepareFixRecoveryClose({ control, observation, histories }))
  const freshObservation = required(makeFixRecoveryObservation({ histories, graph: read.graph, current }))
  const fresh = required(prepareFixRecoveryClose({ control, observation: freshObservation, histories }))
  return required(
    buildConfirmedFixRecoveryClose({
      prepared,
      fresh,
      histories,
      confirmation: {
        route: 'omp-native-command',
        operationId: prepared.proposal.operationId,
        proposalDigest: prepared.digest,
        confirmedAt: '2026-10-27T12:00:00.000Z',
      },
    }),
  )
}
const cwd = process.argv[2]
if (!cwd) throw new Error('fixture-cwd-missing')
const reader = createInstalledUwReadPort({ cwd, gh: defaultGh, readAuthor: 'operator' })
try {
  const read = await reader.readUw({ repository: 'acme/app', target: 'acme/app#42' })
  if (process.argv[3] === 'control') {
    process.stdout.write(`${JSON.stringify(buildFixtureControl(read, cwd))}\n`)
  } else {
    process.stdout.write(
      `${JSON.stringify({
        accepted: read.accepted.status,
        observation: read.observation.status,
        observationDiagnostics: read.observation.status === 'incomplete' ? read.observation.diagnostics : [],
        admission: {
          framed: read.admission.framed.ok,
          deliverable: read.admission.deliverable.ok,
        },
        fixRecovery: read.fixRecovery,
        recoveryEvidence: read.histories.map((history) => ({
          scope: history.source.scope,
          comments: history.source.comments,
          diagnostics: history.diagnostics,
          operations: history.operations,
          owners: history.operations.filter((operation) => operation.claimedKinds.includes('fix-owner')),
        })),
      })}\n`,
    )
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`)
}
