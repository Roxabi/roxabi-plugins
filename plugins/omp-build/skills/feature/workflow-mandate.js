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

export async function liveProofPins(gitCwd, gitFn, baseTip) {
  const top = await gitFn(gitCwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0 || typeof top.stdout !== 'string' || top.stdout.trim() === '')
    throw new Error('git rev-parse --show-toplevel failed')
  const owner = await import('../../roxabi/workflow-pins.ts')
  if (typeof owner.readProofConfigPins !== 'function') throw new Error('shipped proof pin reader is missing')
  const pins = await owner.readProofConfigPins(gitFn, top.stdout.trim(), baseTip)
  if (!Array.isArray(pins)) throw new Error('current proof pins are unreadable')
  return pins
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

function validProofPin(pin) {
  return (
    pin &&
    typeof pin.path === 'string' &&
    pin.path !== '' &&
    isCommitSha(pin.sourceCommit) &&
    (pin.blob === null || isCommitSha(pin.blob))
  )
}

function landingMandateDecision(decision) {
  if (decision?.ok !== true || typeof decision.recordId !== 'string' || !Array.isArray(decision.proofPins)) {
    return { admitted: false, reason: mandateReason(decision?.reason), evidence: decision?.evidence }
  }
  if (decision.proofPins.some((pin) => !validProofPin(pin))) {
    return {
      admitted: false,
      reason: 'unknown-binding',
      evidence: { error: 'landing mandate proof pins are malformed' },
    }
  }
  return { admitted: true, recordId: decision.recordId, proofPins: decision.proofPins }
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
  const [config, proofPins] = await Promise.all([
    trustedLandingWorkflowConfig(gitCwd, gitFn, native.baseTip, productVersion),
    liveProofPins(gitCwd, gitFn, native.baseTip),
  ])
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
    current: { productVersion, ...config, proofPins, ...spec },
    localInhibit: null,
  })
  return landingMandateDecision(decision)
}
