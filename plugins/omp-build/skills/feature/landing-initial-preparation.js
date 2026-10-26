import { isCommitSha } from './workflow-gate.js'
import { resolveRequiredContexts } from './workflow-pr.js'
import { readLandingAt, resolveLandingBase } from './workflow-readiness.js'
import { errorText } from './workflow-runtime.js'

export const landingExit = (result, options = {}) => ({
  result,
  policy: 'allow-approved',
  refresh: true,
  ...options,
})

export const landingRefused = (records, reason) => ({
  status: 'not-approved',
  reviews: records.reviews,
  ...(reason && { reason }),
})

export async function readLandingFields(cwd, pr, gh, fields) {
  return JSON.parse(await gh(cwd, ['pr', 'view', String(pr), '--json', fields]))
}

export function landingBaseBlocked(reason, error) {
  return landingExit({ status: 'base-blocked', reason, error }, { policy: 'unarmed' })
}

export async function mergeParents(cwd, pr, gh, git) {
  const data = await readLandingFields(cwd, pr, gh, 'state,mergeCommit')
  const oid = data.mergeCommit?.oid
  if (data.state !== 'MERGED' || !isCommitSha(oid)) return null
  const first = await git(cwd, ['rev-parse', '--verify', `${oid}^1`])
  if (first.code !== 0 || !isCommitSha(first.stdout.trim())) return null
  const second = await git(cwd, ['rev-parse', '--verify', `${oid}^2`])
  return {
    tip: first.stdout.trim(),
    head: second.code === 0 && isCommitSha(second.stdout.trim()) ? second.stdout.trim() : null,
  }
}

export async function mergedOnto(cwd, pr, gh, git, tip) {
  const parents = await mergeParents(cwd, pr, gh, git)
  return parents !== null && parents.tip === tip
}

export async function mergedAuthorized(cwd, pr, gh, git, tip, candidate) {
  if (!isCommitSha(tip) || !isCommitSha(candidate)) return false
  const parents = await mergeParents(cwd, pr, gh, git)
  return parents !== null && parents.tip === tip && parents.head === candidate
}

export async function bindLandingBase(cwd, pr, gh, git, state, current) {
  if (current.refusal) {
    return landingBaseBlocked(
      current.refusal.reason,
      `PR base ${JSON.stringify(current.name)}: ${current.refusal.error}`,
    )
  }
  const captured = state.landingContext
  if (!captured || (current.name === captured.name && current.tip === captured.tip)) return null
  if (current.name === captured.name && (await mergedOnto(cwd, pr, gh, git, captured.tip))) return null
  return landingBaseBlocked(
    'unbound',
    `PR base ${current.name}@${current.tip} conflicts with captured ${captured.name}@${captured.tip}; re-enter landing with the current base`,
  )
}

async function initialLandingBase(cwd, pr, gh, git, opening) {
  let landingContext
  try {
    landingContext = await resolveLandingBase(cwd, pr, gh, git)
  } catch (error) {
    return {
      terminal: landingBaseBlocked('unreadable', `PR base cannot be read: ${errorText(error)}`),
      state: opening,
    }
  }
  if (landingContext.refusal) {
    return {
      terminal: await bindLandingBase(cwd, pr, gh, git, { landingContext: null }, landingContext),
      state: opening,
    }
  }
  return { landingContext }
}

function initialLandingConfiguration(cwd, landingContext, landing, opening) {
  if (landing) return { resolved: landing }
  try {
    return { resolved: readLandingAt(cwd, landingContext.tip) }
  } catch (error) {
    return {
      terminal: landingExit({ status: 'bad-landing', error: errorText(error) }, { policy: 'unarmed' }),
      state: opening,
    }
  }
}

async function initialNativeRequiredContexts(cwd, landingContext, gh, resolved, requiredContexts) {
  if (requiredContexts !== undefined) return Array.isArray(requiredContexts) ? requiredContexts : []
  if (resolved.required_checks.length) return resolved.required_checks
  return resolveRequiredContexts(cwd, landingContext.name, gh)
}

async function initialLandingRequirement(cwd, landingContext, gh, resolved, requiredContexts, opening) {
  if (resolved.mode !== 'native') return null
  const required = await initialNativeRequiredContexts(cwd, landingContext, gh, resolved, requiredContexts)
  return required.length === 0
    ? { terminal: landingExit({ status: 'no-required-checks' }, { policy: 'unarmed' }), state: opening }
    : null
}

export async function prepareInitialLanding(cwd, pr, gh, git, landing, requiredContexts, opening) {
  const base = await initialLandingBase(cwd, pr, gh, git, opening)
  if (base.terminal) return base
  const configuration = initialLandingConfiguration(cwd, base.landingContext, landing, opening)
  if (configuration.terminal) return configuration
  const requirement = await initialLandingRequirement(
    cwd,
    base.landingContext,
    gh,
    configuration.resolved,
    requiredContexts,
    opening,
  )
  if (requirement) return requirement
  return { landingContext: base.landingContext, resolved: configuration.resolved }
}
