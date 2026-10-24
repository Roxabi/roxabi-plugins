import type { ApplyResult, Deps, PinCandidate, PinSwapPlan } from './pin-swap-contract'
import { parseUvGitDeps, readLockedSha, rewritePyproject } from './pin-swap-source'
import { resolveTagAtSha } from './pin-swap-tags'

function missingLockError(candidate: { name: string; source: { branch: string } }): Error {
  return new Error(
    `pin-swap: ${candidate.name} has branch=${candidate.source.branch} in pyproject.toml but no rev found in uv.lock.\n` +
      `Run 'uv lock' to sync the lock file first.`,
  )
}

function missingTagError(candidate: PinCandidate): Error {
  return new Error(
    `pin-swap: No release tag found at ${candidate.name}@${candidate.sha.slice(0, 8)} on ${candidate.gitUrl}.\n` +
      `Cut a release tag (e.g. ${candidate.name}/vX.Y.Z) at ${candidate.sha.slice(0, 8)} upstream first.`,
  )
}

async function resolveCandidate(
  candidate: { name: string; source: { git: string; branch: string } },
  uvLockText: string,
  deps: Deps,
): Promise<PinCandidate> {
  const sha = readLockedSha(uvLockText, candidate.name)
  if (!sha) throw missingLockError(candidate)
  const tag = await resolveTagAtSha(candidate.source.git, sha, candidate.name, deps)
  if (!tag)
    throw missingTagError({
      name: candidate.name,
      gitUrl: candidate.source.git,
      branch: candidate.source.branch,
      sha,
      tag: '',
    })
  return { name: candidate.name, gitUrl: candidate.source.git, branch: candidate.source.branch, sha, tag }
}

export async function buildPinSwapPlan(cwd: string, deps: Deps): Promise<PinSwapPlan> {
  const pyprojectText = deps.readFile(`${cwd}/pyproject.toml`)
  const uvLockText = deps.readFile(`${cwd}/uv.lock`)
  const candidates: PinCandidate[] = []
  for (const candidate of parseUvGitDeps(pyprojectText)) {
    candidates.push(await resolveCandidate(candidate, uvLockText, deps))
  }
  return { candidates }
}

function rewrittenPyproject(original: string, plan: PinSwapPlan): string {
  return plan.candidates.reduce(
    (pyprojectText, candidate) => rewritePyproject(pyprojectText, candidate.name, candidate.tag),
    original,
  )
}

export async function applyPinSwap(cwd: string, plan: PinSwapPlan, deps: Deps): Promise<ApplyResult> {
  if (plan.candidates.length === 0) return { written: false, staged: false }
  const pyprojectPath = `${cwd}/pyproject.toml`
  const originalPyproject = deps.readFile(pyprojectPath)
  deps.writeFile(pyprojectPath, rewrittenPyproject(originalPyproject, plan))
  try {
    await deps.run(['uv', 'lock'], cwd)
  } catch (err) {
    deps.writeFile(pyprojectPath, originalPyproject)
    throw new Error(`uv lock failed; pyproject.toml restored: ${err instanceof Error ? err.message : String(err)}`)
  }
  await deps.run(['git', 'add', 'pyproject.toml', 'uv.lock'], cwd)
  return { written: true, staged: true }
}

export function formatPlan(plan: PinSwapPlan): string {
  if (plan.candidates.length === 0) return 'pin-swap: no branch= git deps found — skipping.'
  const lines = ['Pin-swap plan:', '']
  for (const candidate of plan.candidates) {
    lines.push(`  ${candidate.name}`)
    lines.push(`    branch=${candidate.branch}  →  tag=${candidate.tag}`)
    lines.push(`    SHA: ${candidate.sha.slice(0, 12)}`)
    lines.push('')
  }
  return lines.join('\n')
}
