import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HooksState, ParseYaml } from './feature-init-types'
import { isMap, type YamlMap } from './feature-init-yaml'

/** Lefthook groups that wrap real git hooks. Manual groups such as `pr:` are excluded. */
export const GIT_HOOK_GROUPS = new Set([
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-rewrite',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-auto-gc',
])

/** lefthook's main config names, in lookup order, then the local override names. */
export const LEFTHOOK_MAIN = [
  'lefthook.yml',
  '.lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yaml',
  '.config/lefthook.yml',
  '.config/lefthook.yaml',
]
export const LEFTHOOK_LOCAL = [
  'lefthook-local.yml',
  '.lefthook-local.yml',
  'lefthook-local.yaml',
  '.lefthook-local.yaml',
  '.config/lefthook-local.yml',
  '.config/lefthook-local.yaml',
]

/** lefthook config formats this reader does not parse. */
export const LEFTHOOK_FOREIGN: readonly ['toml', 'json', 'jsonc'] = ['toml', 'json', 'jsonc']

/** lefthook's local-override merge: maps merge key by key, anything else is replaced. */
function mergeConfig(base: unknown, local: unknown): unknown {
  if (!isMap(base) || !isMap(local)) return local
  const out: YamlMap = { ...base }
  for (const [key, value] of Object.entries(local)) out[key] = mergeConfig(base[key], value)
  return out
}

const SEMCTX = /\bsemctx\b/

function skipped(value: unknown): boolean {
  return isMap(value) && value.skip === true
}

function jobsRunSemctx(jobs: unknown): boolean {
  if (!Array.isArray(jobs)) return false
  return jobs.some((job) => {
    if (!isMap(job) || skipped(job)) return false
    const runsSemctx = ['name', 'run', 'script'].some((key) => {
      const value = job[key]
      return typeof value === 'string' && SEMCTX.test(value)
    })
    return runsSemctx || (isMap(job.group) && !skipped(job.group) && jobsRunSemctx(job.group.jobs))
  })
}

/**
 * True when a lefthook *git-hook* group runs semctx: a command key or its `run`,
 * a `scripts` key, or a job (`name`, `run`, `script`, nested `group.jobs`).
 * `skip: true` on the group, command, script or job removes it. Manual groups
 * such as `pr:` do not count — lefthook does not install them as git hooks.
 */
export function hasSemctxGitHooks(doc: unknown): boolean {
  if (!isMap(doc)) return false
  for (const [group, body] of Object.entries(doc)) {
    if (!GIT_HOOK_GROUPS.has(group) || !isMap(body) || skipped(body)) continue
    const commands = isMap(body.commands) ? Object.entries(body.commands) : []
    const scripts = isMap(body.scripts) ? Object.entries(body.scripts) : []
    if (
      commands.some(
        ([key, cmd]) =>
          !skipped(cmd) && (SEMCTX.test(key) || (isMap(cmd) && typeof cmd.run === 'string' && SEMCTX.test(cmd.run))),
      ) ||
      scripts.some(([key, script]) => !skipped(script) && SEMCTX.test(key)) ||
      jobsRunSemctx(body.jobs)
    ) {
      return true
    }
  }
  return false
}

/**
 * The semctx hook fact from the first main lefthook config and the first local
 * override. A config that cannot be parsed, or is not a map, is `unreadable`; a
 * TOML or JSON config, which is not read here, is reported by its extension. When nothing local
 * runs semctx but the config pulls in `extends`/`remotes`, the answer is
 * `extends`: those files are not read here.
 */
export function semctxHooks(dir: string, parseYaml: ParseYaml): HooksState {
  const pick = (names: string[]) => names.map((name) => join(dir, name)).find((file) => existsSync(file))
  const main = pick(LEFTHOOK_MAIN)
  if (!main) {
    const foreign = LEFTHOOK_FOREIGN.find((ext) =>
      [`lefthook.${ext}`, `.lefthook.${ext}`, `.config/lefthook.${ext}`].some((name) => existsSync(join(dir, name))),
    )
    if (foreign) return `lefthook.${foreign}`
  }
  const files = [main, pick(LEFTHOOK_LOCAL)].filter((file): file is string => Boolean(file))
  let doc: unknown = {}
  for (const file of files) {
    let parsed: unknown
    try {
      parsed = parseYaml(readFileSync(file, 'utf8')) ?? {}
    } catch {
      return 'unreadable'
    }
    if (!isMap(parsed)) return 'unreadable'
    doc = mergeConfig(doc, parsed)
  }
  if (hasSemctxGitHooks(doc)) return 'present'
  if (isMap(doc) && (doc.extends != null || doc.remotes != null)) return 'extends'
  return 'absent'
}

/** True when an existing merge-on-green landing declares a non-empty `required_checks`. */
export function landingHidesChecks(stack: string, mergeOnGreenWorkflow: boolean, parseYaml: ParseYaml): boolean {
  let doc: unknown
  try {
    doc = parseYaml(stack)
  } catch {
    return false
  }
  const landing = isMap(doc) ? doc.landing : null
  if (!isMap(landing)) return false
  const mode = landing.mode ?? (mergeOnGreenWorkflow ? 'merge-on-green' : 'native')
  return mode === 'merge-on-green' && Array.isArray(landing.required_checks) && landing.required_checks.length > 0
}
