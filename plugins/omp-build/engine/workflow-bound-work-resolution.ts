import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import { specDigest } from './record-digests.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedSpec } from './workflow-accepted-spec-types.ts'
import type { BoundWork, ConfigIdentity, MandateUse } from './workflow-binding.ts'
import { historyFor, type MandateRecord, mandateScope, outstandingPauseInAuthority } from './workflow-control.ts'
import { selectApplicableMandate } from './workflow-mandate-admission.ts'
import { selectWorkflowBinding } from './workflow-pr-binding.ts'

type BoundWorkInput = {
  use: MandateUse
  explicitSelection: boolean
  pullRequest: Scope
  histories: readonly DecodedHistory[]
  native: { branch: string; base: string }
  currentSpec?: { body: string; digest: string } | null
}

function configIdentityOf(
  mandate: MandateRecord,
): { ok: true; identity: ConfigIdentity } | { ok: false; evidence: Diagnostic[] } {
  const effective = mandate.payload.config.effective
  const raw =
    effective !== null && typeof effective === 'object' && !Array.isArray(effective)
      ? Reflect.get(effective, 'additionalRequirements')
      : undefined
  const additionalRequirements: string[] = []
  if (raw !== undefined) {
    if (!Array.isArray(raw)) return malformedRequirements()
    for (const item of raw) {
      if (typeof item !== 'string' || item.length === 0) return malformedRequirements()
      additionalRequirements.push(item)
    }
  }
  return {
    ok: true,
    identity: {
      productVersion: mandate.payload.config.productVersion,
      version: mandate.payload.config.version,
      digest: mandate.payload.config.digest,
      additionalRequirements,
      serialized: JSON.stringify({
        productVersion: mandate.payload.config.productVersion,
        version: mandate.payload.config.version,
        digest: mandate.payload.config.digest,
        additionalRequirements,
      }),
    },
  }
}

function malformedRequirements(): { ok: false; evidence: Diagnostic[] } {
  return { ok: false, evidence: [diagnostic('malformed', 'Mandate additional requirements are malformed')] }
}

function absentBinding(input: BoundWorkInput): BoundWork {
  if (input.use !== 'landing' && input.explicitSelection) return { status: 'standalone', binding: 'absent' }
  return {
    status: 'refused',
    reason: 'missing',
    evidence: [diagnostic('mandate-absent', 'No workflow binding exists and selection was not explicit')],
  }
}

function applicableBoundWork(
  input: BoundWorkInput,
  mandate: MandateRecord,
  permissions: { landing: boolean; correct: boolean },
  acceptedSpec: AcceptedSpec,
  configIdentity: ConfigIdentity,
): BoundWork {
  const scope = mandateScope(mandate)
  if (input.currentSpec == null)
    return {
      status: 'applicable',
      binding: 'bound',
      mandate,
      scope,
      permissions,
      acceptedSpec,
      configIdentity,
      drift: null,
    }
  if (specDigest(input.currentSpec.body) !== input.currentSpec.digest) {
    return {
      status: 'refused',
      reason: 'material-spec',
      evidence: [diagnostic('material-spec', 'Current spec digest does not match its body')],
    }
  }
  return {
    status: 'applicable',
    binding: 'bound',
    mandate,
    scope,
    permissions,
    acceptedSpec,
    configIdentity,
    drift: input.currentSpec.digest === acceptedSpec.digest ? 'settled' : 'differs',
  }
}

function authorizedBoundWork(input: BoundWorkInput, mandate: MandateRecord): BoundWork {
  const pause = outstandingPauseInAuthority(mandate, input.histories)
  if (pause !== null) return { status: 'refused', reason: 'unconfirmed', evidence: [pause] }
  const permissions = {
    landing: mandate.payload.permissions.landing && mandate.payload.role !== 'fix-only',
    correct: mandate.payload.permissions.correct,
  }
  if (input.use === 'landing' && !permissions.landing)
    return { status: 'refused', reason: 'fix-only', evidence: [diagnostic('fix-only', 'Fix-only mandate cannot land')] }
  if (input.use === 'correction' && !permissions.correct) {
    return {
      status: 'refused',
      reason: 'incompatible',
      evidence: [diagnostic('incompatible', 'Mandate does not permit correction')],
    }
  }
  const accepted = resolveAcceptedSpec(mandate, input.histories)
  if (!accepted.ok) return { status: 'refused', reason: accepted.reason, evidence: accepted.evidence }
  const identity = configIdentityOf(mandate)
  if (!identity.ok) return { status: 'refused', reason: 'incomplete', evidence: identity.evidence }
  return applicableBoundWork(input, mandate, permissions, accepted.spec, identity.identity)
}

export function resolveBoundWork(input: BoundWorkInput): BoundWork {
  const binding = selectWorkflowBinding(input)
  if (binding.status === 'absent') return absentBinding(input)
  if (binding.status !== 'bound') {
    return {
      status: 'refused',
      reason: binding.status === 'incomplete' ? 'incomplete' : 'ambiguous',
      evidence: binding.diagnostics,
    }
  }
  const mandateHistory = historyFor(mandateScope(binding.mandateRecord), input.histories)
  if (mandateHistory === null) {
    return {
      status: 'refused',
      reason: 'missing-history',
      evidence: [diagnostic('missing-history', 'Bound mandate history is missing')],
    }
  }
  const selected = selectApplicableMandate(mandateHistory, input.histories)
  if (selected.status === 'refused') return { status: 'refused', reason: selected.reason, evidence: selected.evidence }
  if (selected.mandate.recordId !== binding.mandateRecord.recordId) {
    return {
      status: 'refused',
      reason: 'ambiguous',
      evidence: [diagnostic('ambiguous', 'Bound mandate is not the active mandate')],
    }
  }
  return authorizedBoundWork(input, selected.mandate)
}
