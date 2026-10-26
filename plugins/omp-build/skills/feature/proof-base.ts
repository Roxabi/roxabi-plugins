import { lstatSync } from 'node:fs'
import { join } from 'node:path'
export type GitResult = { code: number; stdout: string; stderr: string }
/** Non-throwing Git with untrimmed UTF-8 stdout; qualifying blobs also bind their exact bytes. */
export type Git = (cwd: string, args: string[]) => Promise<GitResult>
export type Gh = (cwd: string, args: string[]) => Promise<string>
export type PrComment = { id?: number; author: { login: string }; body: string; createdAt?: string; updatedAt?: string }

export type Producer = 'semctx' | 'assertledger'
export type RefusalReason = 'unreadable' | 'ambiguous' | 'missing' | 'unbound' | 'verdict' | 'unjustified'
/** `candidate`: the selected candidate or its checkout could not be bound, before any producer applies. */
export type Refusal = { ok: false; producer: Producer | 'candidate'; reason: RefusalReason; error: string }
/** The closed NO TEST enum. Nothing widens it. */
export const NO_TEST_REASONS = ['infra-not-wired', 'prompt-logic-only', 'ui-manual-only', 'out-of-scope'] as const
export type NoTestReason = (typeof NO_TEST_REASONS)[number]

export const SHA = /^[0-9a-f]{40}$/
export const NATIVE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
export const CHANGES_DIR = '.semctx/semantic/changes/'

export function refuse(producer: Producer | 'candidate', reason: RefusalReason, error: string): Refusal {
  return { ok: false, producer, reason, error }
}

export function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Shared strict object guard for capture-time GraphQL and semantic-context responses. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * An ignored `.semctx` directory is not a portable declaration.  We still
 * detect it so a checkout or principal cannot silently downgrade an owed proof
 * to absence; its contents are deliberately never read as configuration.
 */
export async function ignoredSemctxState(git: Git, toplevel: string): Promise<string | Error | null> {
  const listed = await git(toplevel, ['worktree', 'list', '--porcelain', '-z'])
  if (listed.code !== 0) return new Error(gitError(['worktree', 'list', '--porcelain', '-z'], listed))
  const roots = new Set([toplevel])
  const principal = listed.stdout
    .split('\0')
    .find((field) => field.startsWith('worktree '))
    ?.slice('worktree '.length)
  if (principal) roots.add(principal)
  for (const root of roots) {
    const state = join(root, '.semctx')
    try {
      lstatSync(state)
      return state
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
      return new Error(`${JSON.stringify(state)} cannot be read: ${errorMessage(error)}`)
    }
  }
  return null
}

/** One trailing newline is the terminator; everything else — spaces, embedded newlines — is the path. */
export function oneLine(stdout: string): string {
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
}

export function gitError(args: string[], result: GitResult): string {
  return `git ${args.join(' ')} failed (${result.code}): ${(result.stderr || result.stdout).trim() || '(no output)'}`
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `key` of a JSON object answer; undefined when the answer is not an object. */
export function jsonField(raw: string, key: string): unknown {
  const data: unknown = JSON.parse(raw)
  return isMap(data) ? data[key] : undefined
}

export async function repositoryOf(gh: Gh, cwd: string, url?: string): Promise<string> {
  const raw = await gh(cwd, ['repo', 'view', ...(url === undefined ? [] : [url]), '--json', 'nameWithOwner'])
  const name = jsonField(raw, 'nameWithOwner')
  if (typeof name !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(name)) {
    throw new Error(`gh repo view returned no nameWithOwner — ${raw.slice(0, 200)}`)
  }
  return name
}
