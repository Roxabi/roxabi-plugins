import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalValueDigest } from '../engine/canonical-value.ts'
import type { ContextEffectIntent, ContextEffectSources } from '../engine/context-effect-review-schema.ts'
import { contextEffectSources } from '../engine/context-effect-sources.ts'
import { qualifyContextNegative } from '../engine/workflow-context-succession-negative.ts'
import { historyFor, recordsOf } from '../engine/workflow-control.ts'
import { selectedMandate } from '../engine/workflow-mandate-admission.ts'
import type { ContextLocalFileObserver } from '../roxabi/context-local-file-observer.ts'
import type { History } from '../roxabi/feature-engine.ts'
import type { OperatorPort } from '../roxabi/uw-contract.ts'
import {
  createFixtureContextEffectObserverFactory,
  fixtureScopeFromReference,
  writeContextEffectIntentFile,
} from './context-effect-review-fixture.ts'
import { nativeFeatureSpec } from './feature-review-fixture.ts'
import type { SimState } from './sandbox/sandbox-types.ts'

export type OutsideEffectWorkerMode = 'attributed-success' | 'recreate-preselection'

export type OutsideEffectProduceFacts = {
  called: boolean
  dispatches: string[]
  sdkChildren: unknown[]
  sdkErrors: unknown[]
  outsideExistsAfterProduce: boolean
  outsideRealPathAfterProduce: string
  checkoutPorcelainAfterProduce: string
}

export function outsideEffectAgentDir(rootDir: string): string {
  return join(rootDir, 'outside-effect-agent')
}

export function porcelain(checkout: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8' })
}

export function changeOutsideEffectSpecBody(stateFile: string): string {
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as SimState
  const issue = state.issues['42']
  if (!issue) throw new Error('outside-effect-issue-missing')
  const changed = nativeFeatureSpec(fixtureScopeFromReference('#42'), 'preserves the region and timezone')
  issue.body = changed.body
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  return changed.ownSpec.version
}

export function localFilesOutsideEffectIntent(
  sources: ContextEffectSources,
  absoluteOutsidePath: string,
  options: { unresolved?: boolean } = {},
): ContextEffectIntent {
  const resourceKey = 'outside-file'
  const unresolved = { kind: 'unresolved' as const, reason: 'Outside effect still deferred by fixture operator' }
  const attributed = {
    kind: 'local-files' as const,
    resourceKeys: [resourceKey],
    reason: 'Fixture human attribution: conserved Bash wrote the named outside file',
  }
  const nonWriter = {
    kind: 'none-identified' as const,
    reason: 'Non-writing conserved call; outside file attributed only on Bash writers',
  }
  return {
    format: 'omp-build-context-effect-intent/1',
    negatives: sources.map((source) => ({
      source: source.source,
      inventory: source.inventory,
      reportConclusion: options.unresolved ? unresolved : attributed,
      calls:
        source.inventory.kind === 'unavailable'
          ? []
          : source.observations.flatMap((observation) =>
              observation.calls
                .filter((call) => call.toolName !== 'yield')
                .map((call) => ({
                  childId: observation.childId,
                  sessionId: observation.sessionId,
                  ordinal: call.ordinal,
                  toolCallId: call.toolCallId,
                  callDigest: canonicalValueDigest(call),
                  conclusion: options.unresolved
                    ? unresolved
                    : // Writer Bash shares the named key with the report; other tools stay explicit.
                      call.toolName === 'bash'
                      ? attributed
                      : nonWriter,
                })),
            ),
    })),
    resources: options.unresolved
      ? []
      : [
          {
            key: resourceKey,
            absolutePath: absoluteOutsidePath,
            basis: 'accept-named-state',
            expected: { kind: 'absent' },
          },
        ],
  }
}

/**
 * Mutate only after three genuine successful samples (initial, afterBootstrap, premandate)
 * so the fourth/final preselection observation is the guard under test.
 */
export function createRecreateBeforeSelectionObserverFactory(
  absoluteOutsidePath: string,
): () => ContextLocalFileObserver {
  return () => {
    const inner = createFixtureContextEffectObserverFactory()()
    let successfulSamples = 0
    return {
      namespace: inner.namespace,
      active: () => inner.active(),
      async observe(resources) {
        const sampled = await inner.observe(resources)
        if (sampled.ok) {
          successfulSamples += 1
          if (successfulSamples === 3) {
            writeFileSync(absoluteOutsidePath, 'recreated-before-selection\n')
          }
        }
        return sampled
      },
      dispose: () => inner.dispose(),
    }
  }
}

export async function prepareOutsideEffectIntent(input: {
  cwd: string
  negativeRecordId: string
  absoluteOutsidePath: string
  unresolved?: boolean
}) {
  const { createInstalledUwReadPort } = await import('../roxabi/uw-read-port.ts')
  const scope = fixtureScopeFromReference('#42')
  const read = await createInstalledUwReadPort({ cwd: input.cwd, readAuthor: 'operator' }).readUw(scope)
  const history = historyFor(scope, read.histories)
  if (history === null) throw new Error('outside-effect-history-unavailable')
  const mandate = selectedMandate(history)
  if (!('kind' in mandate) || mandate.kind !== 'mandate') throw new Error('outside-effect-mandate-unavailable')
  const matches = recordsOf(history).filter(
    (record) => record.kind === 'action-receipt' && record.recordId === input.negativeRecordId,
  )
  const leaf = matches[0]
  if (matches.length !== 1 || leaf?.kind !== 'action-receipt') throw new Error('outside-effect-negative-unavailable')
  const negative = {
    source: 'record' as const,
    record: { scope, kind: 'action-receipt' as const, recordId: leaf.recordId },
    selector: '/payload' as const,
    digest: canonicalValueDigest(leaf.payload),
  }
  const qualified = qualifyContextNegative({ mandate, histories: read.histories, negative })
  if (!qualified.ok) throw new Error(qualified.diagnostics[0]?.message ?? 'outside-effect-negative-unconfirmed')
  const collected = contextEffectSources(qualified.value.negativeChain)
  if (!collected.ok) throw new Error(collected.diagnostics[0]?.message ?? 'outside-effect-sources-unconfirmed')
  const intent = localFilesOutsideEffectIntent(collected.value.sources, input.absoluteOutsidePath, {
    unresolved: input.unresolved,
  })
  const directory = mkdtempSync(join(input.cwd, '..', 'outside-effect-intent-'))
  const effectsFile = writeContextEffectIntentFile(join(directory, 'context-effect-intent.json'), intent)
  return {
    effectsFile,
    intent,
    sources: collected.value.sources,
    negativeBytes: JSON.stringify(leaf),
    observedTools: leaf.payload.phase === 'result' ? leaf.payload.native.observedTools : undefined,
    structured: leaf.payload.phase === 'result' ? leaf.payload.structured : undefined,
  }
}

export const confirmedOutsideEffectOperator: OperatorPort = {
  async executeConfirmed(prepared, action) {
    return {
      status: 'confirmed',
      value: await action({
        route: 'omp-native-command',
        operationId: prepared.proposal.operationId,
        proposalDigest: prepared.digest,
        confirmedAt: '2026-01-01T00:00:00.000Z',
      }),
    }
  },
}

export function inventorySuccessorPublication(operations: History['operations']) {
  const mandates: string[] = []
  const selectSuccessors: string[] = []
  for (const operation of operations) {
    const record = operation.record
    if (record === null) continue
    if (record.kind === 'mandate') {
      mandates.push(record.recordId)
      continue
    }
    if (record.kind === 'operator-control' && record.payload.control === 'select-successor')
      selectSuccessors.push(record.recordId)
  }
  return {
    mandateRecordIds: mandates,
    selectSuccessorRecordIds: selectSuccessors,
    selectSuccessorPublished: selectSuccessors.length > 0,
  }
}
