import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync } from 'node:child_process'
import { viewer } from '../../dist/contracts.js'
import type { UwReadPort } from '../../roxabi/uw-contract.ts'
import { createInstalledUwReadPort } from '../../roxabi/uw-read-port.ts'

export class Refused extends Error {}
export class Assisted extends Error {}
const GIT_REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']
export type EpicGit = (repo: string, args: string[]) => string
export type EpicGh = (repo: string, args: string[], input?: string) => string
export type ConfigCheck = (repo: string, effective: unknown) => Promise<{ ok: true } | { ok: false; error: string }>
export type EpicEffects = {
  git?: EpicGit
  gh?: EpicGh
  configCompatible?: ConfigCheck
  uw?: UwReadPort
  uwReadAuthor?: string
}
const effects = new AsyncLocalStorage<EpicEffects>()
export const withEpicEffects = <T>(injected: EpicEffects, fn: () => Promise<T>): Promise<T> => effects.run(injected, fn)
export const currentEpicEffects = (): EpicEffects | undefined => effects.getStore()

/** Fresh per driver action; a gather may reuse this port only within its own observation. */
export async function uwReadPort(repo: string): Promise<UwReadPort> {
  const injected = effects.getStore()
  if (injected?.uw) return injected.uw
  const injectedGh = injected?.gh
  const gh = injectedGh === undefined ? undefined : async (cwd: string, args: string[]) => injectedGh(cwd, args)
  const readAuthor = injected?.uwReadAuthor ?? (await viewer({ cwd: repo, ...(gh === undefined ? {} : { gh }) }))
  return createInstalledUwReadPort({ cwd: repo, ...(gh === undefined ? {} : { gh }), readAuthor })
}
function childEnv(): NodeJS.ProcessEnv {
  const out = { ...process.env }
  for (const key of GIT_REDIRECTS) delete out[key]
  return out
}

export function git(repo: string, args: string[]): string {
  const injected = effects.getStore()?.git
  if (injected) return injected(repo, args).trim()
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export function gh(repo: string, args: string[], input?: string): string {
  const injected = effects.getStore()?.gh
  if (injected) return injected(repo, args, input).trim()
  return execFileSync('gh', args, {
    cwd: repo,
    encoding: 'utf8',
    env: childEnv(),
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim()
}

/** One GraphQL call. `T` is the shape the query selects; GraphQL errors throw. */
export function graphql<T>(repo: string, query: string, vars: Record<string, string | number>): T {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [key, value] of Object.entries(vars)) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`)
  const out: unknown = JSON.parse(gh(repo, args))
  if (!out || typeof out !== 'object' || !('data' in out) || !out.data) {
    throw new Error(`graphql: ${JSON.stringify(out).slice(0, 500)}`)
  }
  if ('errors' in out && Array.isArray(out.errors) && out.errors.length) {
    throw new Error(`graphql: ${JSON.stringify(out.errors).slice(0, 500)}`)
  }
  // The query text fixes the shape of `data`; a missing field fails where it is read.
  return out.data as T
}

export function repoName(repo: string): { owner: string; name: string; full: string } {
  const full = gh(repo, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  const [owner, name] = full.split('/')
  if (!owner || !name) throw new Error(`cannot read the repository name: ${full}`)
  return { owner, name, full }
}
