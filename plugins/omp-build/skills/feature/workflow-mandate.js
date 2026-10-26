import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy'
import { bindingRefusalReason, mandateReason } from './workflow-binding.js'
import { isCommitSha } from './workflow-gate.js'
import { repositoryScope } from './workflow-records.js'
import { gitResult } from './workflow-runtime.js'

export function evidenceText(evidence) {
  if (typeof evidence === 'string' && evidence !== '') return evidence
  if (evidence === undefined || evidence === null) return 'landing mandate refused'
  try {
    return JSON.stringify(evidence)
  } catch {
    return 'landing mandate refused'
  }
}

async function bundledLandingMandate() {
  const contracts = await import('../../dist/contracts.js')
  if (
    typeof contracts.requireLandingMandate !== 'function' ||
    typeof contracts.readLandingFacts !== 'function' ||
    typeof contracts.recordIntegrity !== 'function' ||
    typeof contracts.recordOperation !== 'function' ||
    typeof contracts.specDigest !== 'function' ||
    typeof contracts.shippedProductVersion !== 'function'
  )
    throw new Error('requireLandingMandate is not in the trusted contracts bundle')
  return contracts
}

async function trustedLandingWorkflowConfig(gitCwd, gitFn, baseTip, productVersion) {
  const config = await import('../../roxabi/workflow-config.ts')
  const graph = await import('../../roxabi/workflow-graph.ts')
  if (
    typeof config.readEffectiveFixConfig !== 'function' ||
    !Array.isArray(graph.SUPPORTED_CONFIG_VERSIONS) ||
    graph.SUPPORTED_CONFIG_VERSIONS.length === 0
  )
    throw new Error('trusted workflow config reader is incomplete')
  const current = await config.readEffectiveFixConfig({ cwd: gitCwd, commit: baseTip, git: gitFn })
  if (current?.ok !== true)
    throw new Error(`trusted workflow config is ${typeof current?.reason === 'string' ? current.reason : 'unreadable'}`)
  if (
    typeof current.version !== 'string' ||
    current.version === '' ||
    typeof current.digest !== 'string' ||
    current.digest === '' ||
    typeof current.effective?.productVersion !== 'string' ||
    current.effective.productVersion !== productVersion
  )
    throw new Error('trusted workflow config is incomplete')
  return {
    configVersion: current.version,
    configDigest: current.digest,
    supportedConfigVersions: graph.SUPPORTED_CONFIG_VERSIONS,
  }
}

function liveSpec(contracts, scopes, bodies) {
  if (!Array.isArray(scopes) || !Array.isArray(bodies) || bodies.length !== scopes.length)
    throw new Error('landing facts issue bodies are incomplete')
  if (scopes.length === 0) return { specDigest: null, specBody: null }
  if (scopes.length !== 1) throw new Error('landing facts issue bodies are ambiguous')
  const scope = scopes[0]
  const match = bodies.find(
    (entry) => entry?.scope?.repository === scope.repository && entry?.scope?.target === scope.target,
  )
  if (!match || typeof match.body !== 'string') throw new Error('linked issue body is unreadable')
  return { specDigest: contracts.specDigest(match.body), specBody: match.body }
}

function validFactsScopes(facts, pullRequest) {
  return (
    facts.native?.pullRequest &&
    facts.native.pullRequest.repository === pullRequest.repository &&
    facts.native.pullRequest.target === pullRequest.target &&
    Array.isArray(facts.native.linkedIssueScopes) &&
    Array.isArray(facts.parentScopes) &&
    Array.isArray(facts.linkedIssueBodies)
  )
}

function ensureNativeLandingCoordinates(native) {
  if (
    !isCommitSha(native?.head) ||
    typeof native?.base !== 'string' ||
    native.base === '' ||
    !isCommitSha(native?.baseTip)
  )
    throw new Error('current native landing coordinates are incomplete')
}

function landingFactsRefusal(facts) {
  if (facts?.ok === true) return null
  if (!facts || facts.reason === 'unreadable') throw new Error(`landing facts ${facts?.reason ?? 'unreadable'}`)
  return { admitted: false, reason: bindingRefusalReason(facts.reason), evidence: facts.diagnostics ?? facts.evidence }
}

function ensureLandingFactsForNative(facts, pullRequest, native) {
  if (!validFactsScopes(facts, pullRequest)) throw new Error('landing facts scopes are incomplete')
  if (typeof facts.native.branch !== 'string' || facts.native.branch === '' || facts.native.base !== native.base)
    throw new Error('landing facts branch is incomplete')
}

function currentProductVersion(contracts) {
  const productVersion = contracts.shippedProductVersion()
  if (typeof productVersion !== 'string' || productVersion === '') throw new Error('shipped product version is missing')
  return productVersion
}

function landingMandateDecision(decision) {
  if (decision?.ok !== true || typeof decision.recordId !== 'string') {
    return { admitted: false, reason: mandateReason(decision?.reason), evidence: decision?.evidence }
  }
  return { admitted: true, recordId: decision.recordId }
}

function nativeRecordIntegrity(contracts, histories, record) {
  const operation = contracts.recordOperation(histories, record)
  if (operation === null)
    return {
      reason: 'record-unreadable',
      detail: `${record.kind} record ${record.recordId} has no readable native operation`,
    }
  return contracts.recordIntegrity(operation.parts, record)
}

function landingRecordIntegrity(contracts, facts, decision) {
  const binding = nativeRecordIntegrity(contracts, facts.histories, facts.binding)
  if (binding !== null) return binding
  let mandate = decision.mandate
  const seen = new Set()
  while (true) {
    if (seen.has(mandate.recordId))
      return {
        reason: 'record-unreadable',
        detail: `mandate record ${mandate.recordId} has a cyclic admitted parent chain`,
      }
    seen.add(mandate.recordId)
    const integrity = nativeRecordIntegrity(contracts, facts.histories, mandate)
    if (integrity !== null) return integrity
    const parent = mandate.payload.parent
    if (parent === null) return null
    const operation = contracts.recordOperation(facts.histories, { kind: 'mandate', ...parent })
    if (operation?.record?.kind !== 'mandate')
      return {
        reason: 'record-unreadable',
        detail: `mandate record ${parent.recordId} has no readable native operation`,
      }
    mandate = operation.record
  }
}
export async function currentLandingMandate(cwd, pr, ghFn, native, gitFn = gitResult, gitCwd = cwd) {
  ensureNativeLandingCoordinates(native)
  const contracts = await bundledLandingMandate()
  const pullRequest = await repositoryScope(cwd, pr, ghFn)
  const facts = await contracts.readLandingFacts(
    pullRequest,
    withRoxabiGitHubPolicy({ cwd, gh: ghFn, automationLogin: native.automationLogin }),
  )
  const refusal = landingFactsRefusal(facts)
  if (refusal) return refusal
  ensureLandingFactsForNative(facts, pullRequest, native)
  const productVersion = currentProductVersion(contracts)
  const config = await trustedLandingWorkflowConfig(gitCwd, gitFn, native.baseTip, productVersion)
  const spec = liveSpec(contracts, facts.native.linkedIssueScopes, facts.linkedIssueBodies)
  const decision = contracts.requireLandingMandate({
    histories: facts.histories,
    native: {
      branch: facts.native.branch,
      base: native.base,
      pullRequest: facts.native.pullRequest,
      linkedIssueScopes: facts.native.linkedIssueScopes,
    },
    parentScopes: facts.parentScopes,
    current: { productVersion, ...config, ...spec },
    localInhibit: null,
  })
  const admission = landingMandateDecision(decision)
  if (!admission.admitted) return admission
  const integrity = landingRecordIntegrity(contracts, facts, decision)
  if (integrity !== null) return { admitted: false, reason: integrity.reason, evidence: integrity.detail }
  return admission
}
