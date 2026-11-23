import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

export class Refused extends Error {}
export class Assisted extends Error {}
const GIT_REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']
type EpicEffects = { gh?: (repo: string, args: string[], input?: string) => string }
const effects = new AsyncLocalStorage<EpicEffects>()
export const withEpicEffects = <T>(injected: EpicEffects, fn: () => Promise<T>): Promise<T> => effects.run(injected, fn)

function childEnv(): NodeJS.ProcessEnv {
  const out = { ...process.env }
  for (const key of GIT_REDIRECTS) delete out[key]
  return out
}
const execFileAsync = promisify(execFile)

/** Read-only history transport; injected effects still own their own execution. */
export async function ghHistory(repo: string, args: string[]): Promise<string> {
  const injected = effects.getStore()?.gh
  if (injected) return injected(repo, args).trim()
  const { stdout } = await execFileAsync('gh', args, {
    cwd: repo,
    encoding: 'utf8',
    env: childEnv(),
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout.trim()
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
