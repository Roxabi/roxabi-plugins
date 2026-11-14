import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { NativeBatch } from '../omp/review-runtime/contracts.ts'
import type { FeatureCommandHost, FeatureGit } from '../roxabi/feature-contract.ts'
import { releaseFeatureOwner } from '../roxabi/feature-host-ownership.ts'
import { consultableAgentRoot } from './protocol-retention.unit.ts'
import { type BridgeHarness, batch, cleanupFixtureActions } from './review-runtime-support.ts'

export const root = consultableAgentRoot()
const keys: object[] = []

export function cleanup(): void {
  cleanupFixtureActions()
  for (const key of keys.splice(0)) releaseFeatureOwner(key)
}

export function start(recordId: string): ScopedRecordRef {
  return { scope: { repository: 'acme/app', target: 'acme/app#42' }, recordId, kind: 'action-receipt' }
}

type Fixture = { host: FeatureCommandHost; sent: string[]; published: Array<Record<string, unknown>> }

export function fixture(
  harness: BridgeHarness,
  options: {
    git?: FeatureGit
    publish?: (input: Record<string, unknown>, published: Array<Record<string, unknown>>) => void
  } = {},
): Fixture {
  const sent: string[] = []
  const published: Array<Record<string, unknown>> = []
  const key = {}
  keys.push(key)
  const controller = harness.controller
  const host: FeatureCommandHost = {
    key,
    cwd: '/workspace',
    principal: false,
    workflow: {
      async continueFeature() {
        throw new Error('the stop path must not continue')
      },
      async consumeWatchExit() {
        throw new Error('unexpected watch')
      },
      async publishFeatureNativeResult(input) {
        const recorded = input as unknown as Record<string, unknown>
        published.push(recorded)
        options.publish?.(recorded, published)
        return { published: true, retained: true }
      },
      async requestFeatureSessionPause() {
        throw new Error('unexpected pause')
      },
    },
    // Real controller ownership; the announcement transport is outside this lot.
    native: {
      activate: controller.activate.bind(controller),
      inactive: controller.inactive.bind(controller),
      stopOwned: controller.stopOwned.bind(controller),
      async announce() {},
    },
    async send(text) {
      sent.push(text)
    },
    status() {},
    async startFraming() {
      throw new Error('unexpected framing')
    },
    inhibitFeatureContinuation() {},
    releaseFeatureContinuation() {},
    featureContinuationInhibited: () => false,
    markFeatureBatch: (value) => controller.markFeatureBatch(value),
    async exec() {
      throw new Error('unexpected exec')
    },
    ...(options.git === undefined ? {} : { git: options.git }),
  }
  return { host, sent, published }
}

export async function noDelivery(): Promise<void> {
  throw new Error('the stop path must not deliver')
}

export function implementationBatch(): NativeBatch {
  const prepared = batch(['implement'])
  const task = prepared.tasks.tasks[0]
  if (task === undefined) throw new Error('expected a task')
  task.agent = 'R-workflow-implement'
  return prepared
}
