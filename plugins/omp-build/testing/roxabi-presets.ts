import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { PlanOutput } from '../engine/workflow-output-schema.ts'
import type { PlanReviewSlot } from '../engine/workflow-receipt-schema.ts'
import { loadReviewConfig } from '../roxabi/review-config.ts'
import { configPinDigest, effectiveWorkflowConfig, shippedProductVersion } from '../roxabi/workflow-config-digest.ts'
import { WORKFLOW_CONFIG_VERSION } from '../roxabi/workflow-graph.ts'
import { encodedAdmissionReviewGraph } from './record-admission.ts'
import { projectionConfig } from './record-builders.ts'
import { createWorkflowActionFixtures } from './workflow-actions.ts'
import { createWorkflowFixtures } from './workflow-fixtures.ts'

/**
 * Product-only fixture composition. Generic record builders receive this policy
 * as an explicit argument and never load Roxabi configuration themselves.
 */
export function roxabiRecordFixtures() {
  const projection = projectionConfig(loadReviewConfig().canonicalClasses)
  return {
    projection,
    encodedAdmissionReviewGraph: (options: Parameters<typeof encodedAdmissionReviewGraph>[1] = {}) =>
      encodedAdmissionReviewGraph(projection, options),
  }
}

const CATALOGUE = new URL('../skills/dev-review/review-classes.yml', import.meta.url)

const PLAN_OUTPUT: PlanOutput = {
  steps: [
    {
      id: 'step-1',
      change: 'persist the selected region',
      doneWhen: 'the region survives a reload',
      criterion: 'save',
      evidence: 'the save test passes',
      paths: ['src/save.ts'],
    },
  ],
  resolutions: [],
}
const PLAN_SLOTS: readonly PlanReviewSlot[] = [
  { slotId: 'slot-architect', specialist: 'R-workflow-plan-architect' },
  { slotId: 'slot-adversarial', specialist: 'R-workflow-plan-adversarial' },
]

/** Product-only workflow composition; generic workflow fixtures never load these facts. */
export function roxabiWorkflowFixtures() {
  const productVersion = shippedProductVersion()
  const effective = effectiveWorkflowConfig(productVersion, [])
  const context = {
    productVersion,
    config: { version: WORKFLOW_CONFIG_VERSION, digest: configPinDigest(effective), effective },
    head: '1111111111111111111111111111111111111111',
    editedAt: '2026-10-21T12:00:00Z',
  }
  return {
    ...createWorkflowFixtures(context),
    ...createWorkflowActionFixtures({
      planOutput: PLAN_OUTPUT,
      planSlots: PLAN_SLOTS,
      nativeOutcome: { completion: 'completed', strict: 'valid', raw: null },
      head: context.head,
    }),
  }
}

export function roxabiCatalogueConfigPin() {
  const text = readFileSync(CATALOGUE, 'utf8')
  const version = text.match(/^version:\s*"([^"]+)"/m)?.[1]
  if (version === undefined) throw new Error('review catalogue has no version')
  return { version, digest: createHash('sha256').update(text, 'utf8').digest('hex') }
}
