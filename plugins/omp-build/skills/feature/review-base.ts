export type GitResult = { code: number; stdout: string; stderr: string }
/** Non-throwing Git with untrimmed UTF-8 stdout; qualifying blobs also bind their exact bytes. */
export type Git = (cwd: string, args: string[]) => Promise<GitResult>
export type Gh = (cwd: string, args: string[]) => Promise<string>

export type RefusalReason = 'unreadable' | 'unbound'
/** A review input cannot be captured from the current native PR state. */
export type Refusal = { ok: false; reason: RefusalReason; error: string }

export const SHA = /^[0-9a-f]{40}$/

export function refuse(reason: RefusalReason, error: string): Refusal {
  return { ok: false, reason, error }
}

export function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** One trailing newline is the terminator; everything else — spaces, embedded newlines — is the path. */
export function oneLine(stdout: string): string {
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
}

export function gitError(args: string[], result: GitResult): string {
  return `git ${args.join(' ')} failed (${result.code}): ${(result.stderr || result.stdout).trim() || '(no output)'}`
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

/**
 * Establish the selected base: resolve origin's explicit URL through gh and
 * require the selected repository before fetching it. GitHub's `baseRefOid` is
 * recorded when the PR is opened, its head pushed or its base retargeted, and does
 * not follow the branch: the fetch, never that field, is the selected tip, and a
 * later fetch that differs from it is a moved base.
 */
export async function refreshReviewBase(
  cwd: string,
  base: string,
  git: Git,
  gh: Gh,
): Promise<{ ok: true; tip: string } | Refusal> {
  if (!base || base.startsWith('-')) return refuse('unreadable', `PR base ${JSON.stringify(base)} is not a branch name`)
  const remote = await git(cwd, ['remote', 'get-url', 'origin'])
  const url = oneLine(remote.stdout)
  if (remote.code !== 0 || !url || url.startsWith('-'))
    return refuse('unreadable', 'origin has no readable repository URL')
  let selected: string
  let source: string
  try {
    selected = await repositoryOf(gh, cwd)
    source = await repositoryOf(gh, cwd, url)
  } catch {
    return refuse('unreadable', 'gh cannot resolve origin and selected repository identities')
  }
  if (source !== selected)
    return refuse('unbound', `origin repository ${source} conflicts with selected repository ${selected}`)
  // Keep the verified URL, not the mutable remote name, as this fetch's source.
  const fetchArgs = ['fetch', '--quiet', '--no-tags', url, `+refs/heads/${base}:refs/remotes/origin/${base}`]
  const fetched = await git(cwd, fetchArgs)
  if (fetched.code !== 0)
    return refuse('unreadable', `verified origin base ${JSON.stringify(base)} fetch failed (${fetched.code})`)
  const args = ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`]
  const read = await git(cwd, args)
  const tip = oneLine(read.stdout)
  if (read.code !== 0 || !SHA.test(tip)) return refuse('unreadable', gitError(args, read))
  return { ok: true, tip }
}
