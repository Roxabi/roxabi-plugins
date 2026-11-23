import { execFileSync } from 'node:child_process'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { readGitHubHistory } from '../adapters/github/transport.ts'
import { readUwGraph } from '../adapters/github-native/uw-graph-reader.ts'
import { canonicalValueDigest } from '../engine/action-input.ts'
import type { FixRecoveryObservation, FixRecoveryProposal, ScopeCut } from '../engine/fix-recovery-control-schema.ts'
import { pinForComplete } from '../engine/fix-recovery-discovery-records.ts'
import { commentAsPartPin } from '../engine/fix-recovery-part-pins.ts'
import { fixRecoveryExpected } from '../engine/fix-recovery-proposal.ts'
import type { FixOwnerOpenedPayload, FixOwnerSettledPayload, OpenedRef } from '../engine/fix-recovery-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { buildRecord } from '../engine/record-construction.ts'
import { withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import type { Box } from './sandbox/sandbox-types.ts'

function authorityPin<K extends 'mandate' | 'workflow-binding'>(history: DecodedHistory, kind: K, recordId: string) {
  const operation = history.operations.find((item) => item.recordId === recordId)
  const record = operation?.record
  if (operation?.status !== 'complete' || record?.kind !== kind) throw new Error(`fixture-${kind}-missing`)
  const identity = { scope: history.source.scope, kind, recordId, runId: record.runId, operationId: record.operationId }
  return { record, pin: pinForComplete(identity, record, operation) }
}

function historyCut(history: DecodedHistory): FixRecoveryObservation['histories'][number] {
  const { complete, scope, expectedAuthor, stopAuthor } = history.source
  if (!complete) throw new Error(`fixture-history-incomplete:${scope.target}`)
  const parts = history.operations
    .filter((operation) => operation.authority !== 'foreign')
    .flatMap((operation) => operation.parts)
    .map((comment) => {
      const part = commentAsPartPin(comment)
      if (part === null) throw new Error(`fixture-part-unpinnable:${comment.locator}`)
      return part
    })
  return { scope, expectedAuthor, stopAuthor, complete, parts }
}

/** Encode a historical wire record from fixture facts, without invoking native preparation or confirmation. */
export async function buildHistoricalFixRecoveryClose(input: {
  box: Box
  cwd: string
  opening: FixOwnerOpenedPayload
  settlement: FixOwnerSettledPayload
  settled: OpenedRef
}) {
  const {
    box,
    cwd,
    opening: { common },
    settlement,
    settled,
  } = input
  const { uw, pullRequest, binding, mandate, destination, host, root } = common
  const { opened, interrupted: target } = settlement
  if (host.kind !== 'linux-qualified' || target.kind !== 'publication-prefix') throw new Error('fixture-close-basis')
  const options = withRoxabiGitHubPolicy({
    cwd,
    readAuthor: 'operator',
    gh: async (dir, args) => execFileSync('gh', args, { cwd: dir, env: box.env, encoding: 'utf8' }),
  })
  const [snapshot, issueSource, prSource] = await Promise.all([
    readUwGraph(uw, options),
    readGitHubHistory(uw, options),
    readGitHubHistory(pullRequest, options),
  ])
  const leaf = snapshot.nodes[0]
  const baseGitSHA = box.sha.main
  if (snapshot.status !== 'complete' || snapshot.nodes.length !== 1 || !leaf || !baseGitSHA)
    throw new Error('fixture-close-graph')
  const { reference, body, bodySha256 } = leaf.raw
  const graph = {
    root: snapshot.root,
    nodes: [
      {
        uw: leaf.uw,
        title: leaf.title,
        raw: { reference, body, bodySha256 },
        labels: [...leaf.labels].sort(),
        wayfinderLabels: [...leaf.wayfinderLabels].sort(),
        parent: leaf.parent,
        children: [...leaf.children],
        blockers: [...leaf.blockers],
        native: leaf.native,
      },
    ],
  }
  const issue = decodeHistory(issueSource)
  const pr = decodeHistory(prSource)
  const bindingAnchor = authorityPin(pr, 'workflow-binding', binding.recordId)
  if (bindingAnchor.record.kind !== 'workflow-binding') throw new Error('fixture-binding-kind')
  const { branch, base } = bindingAnchor.record.payload
  const files = [...common.plugin.files].sort((a, b) => {
    const left = [a.repository, a.commit, a.path].join('\0')
    const right = [b.repository, b.commit, b.path].join('\0')
    return left < right ? -1 : left > right ? 1 : 0
  })
  // The fixed fixture scopes sort UW #42 before PR #7; source contribution sorts before fix-request.
  const cuts: ScopeCut[] = [
    { scope: uw, retiringOpened: opened, members: [] },
    {
      scope: pullRequest,
      retiringOpened: opened,
      members: settlement.outbound.map(({ identity, publication }) =>
        publication.state === 'confirmed'
          ? { disposition: 'keep-complete', record: publication.record }
          : {
              disposition: 'retire-incomplete',
              identity,
              observedParts: publication.state === 'submitted-unconfirmed' ? publication.observedParts : [],
            },
      ),
    },
  ]
  const observation: FixRecoveryObservation = {
    format: 'omp-build-fix-recovery-observation/1',
    histories: [historyCut(issue), historyCut(pr)],
    graph,
    authority: {
      mandate: authorityPin(issue, 'mandate', mandate.recordId).pin,
      binding: bindingAnchor.pin,
      plugin: { ...common.plugin, files },
      configuration: common.configuration,
      accepted: common.accepted,
    },
    pullRequest: {
      scope: pullRequest,
      state: 'open',
      candidateGitSHA: settlement.local.head,
      baseGitSHA,
      headRepository: destination.publicationRepository,
      branch,
      base,
      destination,
    },
    local: { ...settlement.local, status: { format: 'git-status-porcelain-v1', stdout: '' } },
    host: { process: host.process, root, namespace: host.namespace, prior: { kind: 'sealed-drained-live' } },
  }
  const control = {
    scope: pullRequest,
    kind: 'fix-recovery' as const,
    runId: 'recovery-fixture-run',
    operationId: 'recovery-fixture-operation',
    recordId: 'recovery-fixture-control',
  }
  const facts = {
    phase: 'close-publication' as const,
    uw,
    pullRequest,
    binding,
    mandate,
    predecessor: null,
    opened,
    settled,
    cuts,
    observation,
    observationDigest: canonicalValueDigest(observation),
    target,
  }
  const proposal: FixRecoveryProposal = {
    format: 'omp-build-fix-recovery-proposal/1',
    operationId: control.operationId,
    control,
    ...facts,
    expected: fixRecoveryExpected(observation),
  }
  const proposalDigest = canonicalValueDigest(proposal)
  const record = buildRecord({
    ...control.scope,
    version: 1,
    operationId: control.operationId,
    runId: control.runId,
    recordId: control.recordId,
    kind: control.kind,
    payload: {
      ...facts,
      format: 'omp-build-fix-recovery/1',
      proposalDigest,
      confirmation: {
        route: 'omp-native-command',
        operationId: control.operationId,
        proposalDigest,
        confirmedAt: '2026-10-27T12:00:00.000Z',
      },
    },
  })
  if (!record.ok) throw new Error(`fixture-historical-close-invalid:${JSON.stringify(record.diagnostics)}`)
  return record.value
}
