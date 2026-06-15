/**
 * pin-swap.ts — uv git-dep pin-swap phase for /promote
 *
 * Detects [tool.uv.sources] entries with branch= and rewrites them to tag=
 * using the SHA pinned in uv.lock resolved to a matching release tag.
 *
 * Designed for pure-logic testability: all I/O is injected via Deps interface.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UvGitSource {
  git: string
  branch: string
}

export interface GitDep {
  name: string
  source: UvGitSource
}

export interface PinCandidate {
  name: string
  gitUrl: string
  branch: string
  sha: string
  tag: string
}

export interface PinSwapPlan {
  candidates: PinCandidate[]
}

export interface ApplyResult {
  written: boolean
  staged: boolean
}

// ─── Dependencies (injected for testability) ──────────────────────────────────

export interface Deps {
  /** Read a file from disk, return its text content. */
  readFile: (path: string) => string
  /** Write text content to a file on disk. */
  writeFile: (path: string, content: string) => void
  /** Run a shell command, return trimmed stdout. Throws on non-zero exit. */
  run: (cmd: string[], cwd?: string) => Promise<string>
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse [tool.uv.sources] from pyproject.toml text.
 * Returns only entries that have both `git =` and `branch =` fields.
 *
 * Handles TOML inline tables: { git = "...", branch = "..." }
 * and multi-key blocks under [tool.uv.sources.<name>].
 */
export function parseUvGitDeps(pyprojectText: string): GitDep[] {
  const deps: GitDep[] = []
  const lines = pyprojectText.split('\n')

  // State machine: inside [tool.uv.sources] block?
  let inSources = false
  let currentName: string | null = null
  let currentGit: string | null = null
  let currentBranch: string | null = null

  function flushBlock() {
    if (currentName && currentGit && currentBranch) {
      deps.push({ name: currentName, source: { git: currentGit, branch: currentBranch } })
    }
    currentName = null
    currentGit = null
    currentBranch = null
  }

  for (const line of lines) {
    const trimmed = line.trim()

    // Section header detection
    if (trimmed.startsWith('[')) {
      flushBlock()

      // Sub-table header: [tool.uv.sources.name] — sets inSources + currentName
      const subTableMatch = trimmed.match(/^\[tool\.uv\.sources\.([^\]]+)\]$/)
      if (subTableMatch) {
        inSources = true
        currentName = subTableMatch[1]
        continue
      }

      if (trimmed === '[tool.uv.sources]') {
        inSources = true
        continue
      }

      // Any other section header ends sources block
      inSources = false
      continue
    }

    if (!inSources) continue

    // Inline table: name = { git = "...", branch = "..." }
    const inlineMatch = trimmed.match(/^(\S+)\s*=\s*\{([^}]*)\}/)
    if (inlineMatch && !currentName) {
      const name = inlineMatch[1]
      const body = inlineMatch[2]
      const gitMatch = body.match(/git\s*=\s*["']([^"']+)["']/)
      const branchMatch = body.match(/branch\s*=\s*["']([^"']+)["']/)
      if (gitMatch && branchMatch) {
        deps.push({ name, source: { git: gitMatch[1], branch: branchMatch[1] } })
      }
      continue
    }

    // Key = value inside a sub-table
    if (currentName) {
      const gitVal = trimmed.match(/^git\s*=\s*["']([^"']+)["']/)
      if (gitVal) {
        currentGit = gitVal[1]
        continue
      }
      const branchVal = trimmed.match(/^branch\s*=\s*["']([^"']+)["']/)
      if (branchVal) {
        currentBranch = branchVal[1]
      }
    }
  }

  flushBlock()
  return deps
}

// ─── Lock file parsing ────────────────────────────────────────────────────────

/**
 * Read the pinned SHA for a package from uv.lock.
 *
 * uv.lock format (TOML-like):
 *   [[package]]
 *   name = "pkg-name"
 *   ...
 *   source = { git = "https://...", rev = "<sha>" }
 */
export function readLockedSha(uvLockText: string, pkgName: string): string | null {
  const blocks = uvLockText.split(/(?=\[\[package\]\])/g)
  for (const block of blocks) {
    // Check name matches (normalize hyphens/underscores for comparison)
    const nameMatch = block.match(/^name\s*=\s*["']([^"']+)["']/m)
    if (!nameMatch) continue
    const blockName = nameMatch[1].toLowerCase().replace(/-/g, '_')
    const target = pkgName.toLowerCase().replace(/-/g, '_')
    if (blockName !== target) continue

    // Extract rev from source line
    const revMatch = block.match(/rev\s*=\s*["']([a-f0-9]{40})["']/)
    if (revMatch) return revMatch[1]
  }
  return null
}

// ─── Tag resolution ───────────────────────────────────────────────────────────

/**
 * Resolve a SHA to a release tag at that exact commit on the remote.
 *
 * Fetches tags via `git ls-remote --tags <gitUrl>` and matches
 * tags pointing at the given SHA. Supports monorepo-style tags
 * like `<pkg>/vX.Y.Z` as well as flat `vX.Y.Z`.
 *
 * Returns the best match (prefer `<pkgName>/vX.Y.Z`, fall back to `vX.Y.Z`).
 */
export async function resolveTagAtSha(
  gitUrl: string,
  sha: string,
  pkgName: string,
  deps: Pick<Deps, 'run'>,
): Promise<string | null> {
  let lsRemoteOut: string
  try {
    lsRemoteOut = await deps.run(['git', 'ls-remote', '--tags', gitUrl])
  } catch (err) {
    throw new Error(`Failed to query ${gitUrl} for tags at ${sha}: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!lsRemoteOut) return null

  // Parse ls-remote output: "<sha>\trefs/tags/<tag>"
  // Annotated tags have a "^{}" dereference line with the commit SHA
  const tagLines = lsRemoteOut.split('\n').filter(Boolean)

  // Build map: tagName → set of SHAs (commit SHA from ^{} line, or direct)
  const tagToShas = new Map<string, Set<string>>()
  for (const line of tagLines) {
    const parts = line.split('\t')
    if (parts.length < 2) continue
    const lineSha = parts[0].trim()
    const ref = parts[1].trim()
    // refs/tags/<name>^{} = dereferenced (points to commit), refs/tags/<name> = tag object
    const tagMatch = ref.match(/^refs\/tags\/(.+?)(\^\{\})?$/)
    if (!tagMatch) continue
    const tagName = tagMatch[1]
    if (!tagToShas.has(tagName)) tagToShas.set(tagName, new Set())
    tagToShas.get(tagName)?.add(lineSha)
  }

  // Filter to release-style tags matching the SHA
  const matchingTags: string[] = []
  const normalizedPkg = pkgName.replace(/_/g, '-').toLowerCase()

  for (const [tagName, shas] of tagToShas) {
    if (!shas.has(sha)) continue
    // Accept: vX.Y.Z, <pkg>/vX.Y.Z, <pkg>/vX.Y.Z-suffix
    if (!/v\d+\.\d+\.\d+/.test(tagName)) continue
    matchingTags.push(tagName)
  }

  if (matchingTags.length === 0) return null

  // Prefer <pkgName>/vX.Y.Z (monorepo-style) over bare vX.Y.Z
  const monorepoMatch = matchingTags.find((t) => t.toLowerCase().startsWith(`${normalizedPkg}/`))
  if (monorepoMatch) return monorepoMatch

  // Fall back to bare version tag — sort numerically to avoid lexicographic misorder (v1.9 > v1.10)
  const parseVersion = (tag: string): [number, number, number] => {
    const m = tag.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
  }
  const compareSemver = (a: string, b: string) => {
    const [a1, a2, a3] = parseVersion(a)
    const [b1, b2, b3] = parseVersion(b)
    return a1 - b1 || a2 - b2 || a3 - b3
  }
  return [...matchingTags].sort(compareSemver).reverse()[0] ?? null
}

// ─── pyproject rewriting ──────────────────────────────────────────────────────

/**
 * Rewrite [tool.uv.sources] in pyproject.toml text:
 * replace `branch = "<branch>"` with `tag = "<tag>"` for the given package.
 *
 * Handles both inline table and sub-table forms.
 * Returns the rewritten text (does NOT mutate the input).
 */
export function rewritePyproject(pyprojectText: string, pkgName: string, tag: string): string {
  const lines = pyprojectText.split('\n')
  const result: string[] = []
  let inSources = false
  let inPkgBlock = false
  let foundAndRewroteInline = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed.startsWith('[')) {
      inPkgBlock = false
      if (trimmed === '[tool.uv.sources]') {
        inSources = true
      } else if (trimmed === `[tool.uv.sources.${pkgName}]`) {
        // Direct sub-table header — sets both inSources and inPkgBlock
        inSources = true
        inPkgBlock = true
      } else if (inSources && trimmed.startsWith('[tool.uv.sources.')) {
        // Another sub-table inside sources, but not our target
        inSources = true
      } else {
        inSources = false
      }
      result.push(line)
      continue
    }

    // Inline table form: pkgName = { git = "...", branch = "staging" }
    if (inSources && !foundAndRewroteInline) {
      const inlineRegex = new RegExp(`^(\\s*${pkgName}\\s*=\\s*\\{[^}]*)branch\\s*=\\s*["'][^"']*["']([^}]*\\})`)
      if (inlineRegex.test(line)) {
        const rewritten = line.replace(/branch\s*=\s*["'][^"']*["']/, `tag = "${tag}"`)
        result.push(rewritten)
        foundAndRewroteInline = true
        continue
      }
    }

    // Sub-table form: inside [tool.uv.sources.<pkgName>], replace branch = ... line
    if (inPkgBlock && /^\s*branch\s*=/.test(line)) {
      const indent = line.match(/^(\s*)/)?.[1] ?? ''
      result.push(`${indent}tag = "${tag}"`)
      continue
    }

    result.push(line)
  }

  return result.join('\n')
}

// ─── Plan building ────────────────────────────────────────────────────────────

/**
 * Build the pin-swap plan: detect branch= git deps, resolve SHAs and tags.
 *
 * Returns { candidates } where each candidate has: name, gitUrl, branch, sha, tag.
 * Throws with an actionable message if a SHA cannot be resolved to a tag.
 *
 * @param cwd  Working directory containing pyproject.toml and uv.lock
 */
export async function buildPinSwapPlan(cwd: string, deps: Deps): Promise<PinSwapPlan> {
  const pyprojectText = deps.readFile(`${cwd}/pyproject.toml`)
  const uvLockText = deps.readFile(`${cwd}/uv.lock`)

  const gitDeps = parseUvGitDeps(pyprojectText)
  if (gitDeps.length === 0) return { candidates: [] }

  const candidates: PinCandidate[] = []

  for (const dep of gitDeps) {
    const sha = readLockedSha(uvLockText, dep.name)
    if (!sha) {
      throw new Error(
        `pin-swap: ${dep.name} has branch=${dep.source.branch} in pyproject.toml but no rev found in uv.lock.\n` +
          `Run 'uv lock' to sync the lock file first.`,
      )
    }

    const tag = await resolveTagAtSha(dep.source.git, sha, dep.name, deps)
    if (!tag) {
      throw new Error(
        `pin-swap: No release tag found at ${dep.name}@${sha.slice(0, 8)} on ${dep.source.git}.\n` +
          `Cut a release tag (e.g. ${dep.name}/vX.Y.Z) at ${sha.slice(0, 8)} upstream first.`,
      )
    }

    candidates.push({
      name: dep.name,
      gitUrl: dep.source.git,
      branch: dep.source.branch,
      sha,
      tag,
    })
  }

  return { candidates }
}

// ─── Apply ────────────────────────────────────────────────────────────────────

/**
 * Apply the pin-swap plan: rewrite pyproject.toml, regenerate uv.lock, stage both.
 *
 * @param cwd  Working directory
 * @param plan  Plan from buildPinSwapPlan
 */
export async function applyPinSwap(cwd: string, plan: PinSwapPlan, deps: Deps): Promise<ApplyResult> {
  if (plan.candidates.length === 0) return { written: false, staged: false }

  const originalPyproject = deps.readFile(`${cwd}/pyproject.toml`)
  let pyprojectText = originalPyproject

  for (const candidate of plan.candidates) {
    pyprojectText = rewritePyproject(pyprojectText, candidate.name, candidate.tag)
  }

  deps.writeFile(`${cwd}/pyproject.toml`, pyprojectText)

  // Regenerate lock file — restore pyproject on failure to avoid corrupted working tree
  try {
    await deps.run(['uv', 'lock'], cwd)
  } catch (err) {
    deps.writeFile(`${cwd}/pyproject.toml`, originalPyproject)
    throw new Error(`uv lock failed; pyproject.toml restored: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Stage both files
  await deps.run(['git', 'add', 'pyproject.toml', 'uv.lock'], cwd)

  return { written: true, staged: true }
}

// ─── Dry-run formatting ───────────────────────────────────────────────────────

/**
 * Format a pin-swap plan as a human-readable diff for display.
 */
export function formatPlan(plan: PinSwapPlan): string {
  if (plan.candidates.length === 0) {
    return 'pin-swap: no branch= git deps found — skipping.'
  }

  const lines = ['Pin-swap plan:', '']
  for (const c of plan.candidates) {
    lines.push(`  ${c.name}`)
    lines.push(`    branch=${c.branch}  →  tag=${c.tag}`)
    lines.push(`    SHA: ${c.sha.slice(0, 12)}`)
    lines.push('')
  }
  return lines.join('\n')
}
