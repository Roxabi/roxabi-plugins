import { assessUwAdmission } from '../dist/contracts.js'
import type { CurrentChildrenProjection, UwAdmission } from '../engine/uw-admission.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { WorkflowCausalContext } from '../engine/workflow-plan.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { assembleChantier, type Delivery } from './feature-delivery-facts.ts'
import type { WorkflowEvidence } from './feature-engine.ts'
import type { UwRead } from './uw-contract.ts'
import { type CurrentOwnSpecFacts, readAssessmentSpecFacts, readCurrentOwnSpecFacts } from './uw-current-facts.ts'
import { createInstalledObservedUwReadPort, UwGraphUnavailableError } from './uw-read-port.ts'
import { configPinDigest, effectiveWorkflowConfig } from './workflow-config-digest.ts'
import { SUPPORTED_CONFIG_VERSIONS } from './workflow-graph.ts'
import { additionalRequirementsOf } from './workflow-overrides.ts'

type FreshUwDeliveryAdmission = { admission: UwAdmission } | { diagnostics: readonly UwDiagnostic[] } | null

export type FeatureAdmissionObservation = {
  evidence: WorkflowEvidence
  delivery: Delivery | null
  deliveryAdmission: FreshUwDeliveryAdmission
  facts: {
    currentSpec: CurrentOwnSpecFacts['currentSpec'] | null
    productVersion: string
    configDigest: string
    supportedConfigVersions: readonly string[]
  }
}

type CurrentSpecObservation = Pick<FeatureAdmissionObservation['facts'], 'currentSpec'> & {
  deliveryAdmission: FreshUwDeliveryAdmission
}

function unavailable(diagnostics: readonly UwDiagnostic[]): CurrentSpecObservation {
  return { currentSpec: null, deliveryAdmission: { diagnostics } }
}

async function currentSpecFacts(
  selected: SelectedFeature,
  read: UwRead | null,
  causal: WorkflowCausalContext,
): Promise<CurrentSpecObservation | ContinueFeatureResult> {
  if (selected.reader === null || read === null) return { currentSpec: null, deliveryAdmission: null }
  if (!read.identity.ok) return unavailable(read.identity.diagnostics)
  const facts =
    read.accepted.status === 'accepted'
      ? await readAssessmentSpecFacts({
          uw: selected.authority.scope,
          read,
        })
      : await readCurrentOwnSpecFacts({ uw: selected.authority.scope, read })
  if (!facts.ok && 'coverageRequest' in facts) return { kind: 'blocked', reason: facts.reason }
  const currentChildren: CurrentChildrenProjection = facts.ok
    ? {
        ok: true,
        value: facts.value.currentSpec.children.map(({ scope, specVersion, tier }) => ({ scope, specVersion, tier })),
      }
    : { ok: false, diagnostics: facts.diagnostics }
  const admission = assessUwAdmission({
    uw: selected.authority.scope,
    graph: read.graph,
    proposed: read.proposed,
    accepted: read.accepted,
    identities: read.identity.value,
    histories: causal.histories,
    catalogues: causal.catalogues,
    completion: read.completion,
    phase: 'delivery-transition',
    currentChildren,
  })
  return { currentSpec: facts.ok ? facts.value.currentSpec : null, deliveryAdmission: { admission } }
}

async function readObservationUw(selected: SelectedFeature): Promise<UwRead | null | ContinueFeatureResult> {
  if (selected.reader === null) return null
  try {
    return await selected.reader.readUw(selected.authority.scope)
  } catch (error) {
    if (error instanceof UwGraphUnavailableError)
      return { kind: 'blocked', reason: 'uw-graph-unavailable', diagnostics: error.diagnostics }
    throw error
  }
}

/** The latest read before any decision; a held framing aggregate stops every transition here. */
async function observedCurrentRead(
  selected: SelectedFeature,
  uwRead: UwRead | null,
  observation: Parameters<typeof createInstalledObservedUwReadPort>[0]['observation'],
): Promise<{ read: UwRead | null } | ContinueFeatureResult> {
  if (uwRead === null) return { read: null }
  const read = await createInstalledObservedUwReadPort({ observation }).readUw(selected.authority.scope)
  const aggregate = read.admission.aggregate
  if (aggregate.status === 'held')
    return { kind: 'blocked', reason: aggregate.code, diagnostics: aggregate.diagnostics }
  return { read }
}

export async function assembleObservationBase(
  selected: SelectedFeature,
): Promise<FeatureAdmissionObservation | ContinueFeatureResult> {
  const { authority, mandate } = selected
  const { context, target, history } = authority
  const uwRead = await readObservationUw(selected)
  if (uwRead !== null && 'kind' in uwRead) return uwRead
  const assembled = await assembleChantier(context.engine, target, history, mandate, uwRead, {
    cwd: context.cwd,
    gh: context.gh,
  })
  if (!assembled.ok) return { kind: 'blocked', reason: assembled.reason, diagnostics: assembled.diagnostics }
  const { evidence, delivery } = assembled
  const productVersion = context.engine.shippedProductVersion()
  const requirements = additionalRequirementsOf(mandate?.payload.config.effective)
  const effectiveConfig = effectiveWorkflowConfig(productVersion, requirements)
  const current = await observedCurrentRead(selected, uwRead, evidence.causal.observation)
  if ('kind' in current) return current
  const currentFacts = await currentSpecFacts(selected, current.read, evidence.causal)
  if ('kind' in currentFacts) return currentFacts
  return {
    evidence,
    delivery,
    deliveryAdmission: currentFacts.deliveryAdmission,
    facts: {
      currentSpec: currentFacts.currentSpec,
      productVersion,
      configDigest: configPinDigest(effectiveConfig),
      supportedConfigVersions: SUPPORTED_CONFIG_VERSIONS,
    },
  }
}
