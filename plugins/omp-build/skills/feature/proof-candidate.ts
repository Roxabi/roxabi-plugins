import { type Gh, type Git, gitError, oneLine, type Refusal, refuse, repositoryOf, SHA } from './proof-base'
/**
 * Establish the selected base: resolve origin's explicit URL through gh and
 * require the selected repository before fetching it. GitHub's `baseRefOid` is
 * recorded when the PR is opened, its head pushed or its base retargeted, and does
 * not follow the branch: the fetch, never that field, is the selected tip, and a
 * later fetch that differs from it is a moved base.
 */
export async function refreshSelectedBase(
  cwd: string,
  base: string,
  git: Git,
  gh: Gh,
): Promise<{ ok: true; tip: string } | Refusal> {
  if (!base || base.startsWith('-'))
    return refuse('candidate', 'unreadable', `PR base ${JSON.stringify(base)} is not a branch name`)
  const remote = await git(cwd, ['remote', 'get-url', 'origin'])
  const url = oneLine(remote.stdout)
  if (remote.code !== 0 || !url || url.startsWith('-'))
    return refuse('candidate', 'unreadable', 'origin has no readable repository URL')
  let selected: string
  let source: string
  try {
    selected = await repositoryOf(gh, cwd)
    source = await repositoryOf(gh, cwd, url)
  } catch {
    return refuse('candidate', 'unreadable', 'gh cannot resolve origin and selected repository identities')
  }
  if (source !== selected)
    return refuse('candidate', 'unbound', `origin repository ${source} conflicts with selected repository ${selected}`)
  // Keep the verified URL, not the mutable remote name, as this fetch's source.
  const fetchArgs = ['fetch', '--quiet', '--no-tags', url, `+refs/heads/${base}:refs/remotes/origin/${base}`]
  const fetched = await git(cwd, fetchArgs)
  if (fetched.code !== 0)
    return refuse(
      'candidate',
      'unreadable',
      `verified origin base ${JSON.stringify(base)} fetch failed (${fetched.code})`,
    )
  const args = ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`]
  const read = await git(cwd, args)
  const tip = oneLine(read.stdout)
  if (read.code !== 0 || !SHA.test(tip)) return refuse('candidate', 'unreadable', gitError(args, read))
  return { ok: true, tip }
}
