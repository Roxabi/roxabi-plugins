import type { NativeEpicPullRequest } from '../../adapters/github-native/epic-children.ts'
import { type DecodedHistory, decodeHistory, githubScope, readGitHubHistory } from '../../dist/contracts.js'
import { mandateParentHistories } from '../../roxabi/feature-context.ts'
import { loadContracts } from '../../roxabi/feature-engine.ts'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy.ts'
import { gh, ghHistory, Refused } from './epic-driver-runtime'
import authorization from './head-authorization.cjs'

export function repoName(repo: string): { owner: string; name: string; full: string } {
  const full = gh(repo, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  const [owner, name] = full.split('/')
  if (!owner || !name) throw new Error(`cannot read the repository name: ${full}`)
  return { owner, name, full }
}

const adapterGhByRepo = new Map<string, (cwd: string, args: string[]) => Promise<string>>()
let adapterViewerLogin: string | undefined

export function adapterOptions(repo: string) {
  let transport = adapterGhByRepo.get(repo)
  if (transport === undefined) {
    transport = async (cwd: string, args: string[]) => gh(cwd, args)
    adapterGhByRepo.set(repo, transport)
  }
  if (adapterViewerLogin === undefined) {
    const login = gh(repo, ['api', 'user', '--jq', '.login']).trim()
    if (!login || /\s/.test(login)) throw new Error('gh api user returned no login')
    adapterViewerLogin = login
  }
  return {
    ...withRoxabiGitHubPolicy({
      cwd: repo,
      gh: transport,
      automationLogin: adapterViewerLogin,
      writerLogin: adapterViewerLogin,
    }),
    gh: transport,
  }
}

export async function issueHistory(repo: string, repository: string, issue: number): Promise<DecodedHistory> {
  return decodeHistory(
    await readGitHubHistory(githubScope(repository, issue), { ...adapterOptions(repo), gh: ghHistory }),
  )
}

export async function parentMandateHistories(repo: string, history: DecodedHistory): Promise<DecodedHistory[]> {
  const loaded = await loadContracts()
  if ('missing' in loaded) throw new Refused(`engine-unavailable:${loaded.missing}`)
  const result = await mandateParentHistories(loaded, history, adapterOptions(repo))
  if (!result.ok) throw new Refused(result.reason)
  return result.parents
}

async function pullRequestArmed(
  cwd: string,
  pr: NativeEpicPullRequest,
  policy: Parameters<typeof authorization.readAuthorization>[0]['policy'] | null,
  transport: (cwd: string, args: string[]) => Promise<string>,
): Promise<boolean> {
  if (pr.state !== 'OPEN') return false
  const [owner, name] = pr.repository.nameWithOwner.split('/')
  if (!owner || !name) throw new Refused(`PR #${pr.number} authorization scope is invalid`)
  if (policy === null) return pr.autoMergeRequest !== null
  const state = await authorization.readAuthorization({
    cwd,
    gh: transport,
    repo: { owner, repo: name },
    prNumber: pr.number,
    policy,
  })
  if (state.scope.headSha !== pr.headRefOid) throw new Refused(`PR #${pr.number} head changed during inventory`)
  return state.allowed || pr.autoMergeRequest !== null
}

export async function armedPullRequests(repo: string, prs: readonly NativeEpicPullRequest[]): Promise<Set<number>> {
  const armed = new Set<number>()
  const transport = async (cwd: string, args: string[]) => gh(cwd, args)
  const policy = prs.some((pr) => pr.state === 'OPEN')
    ? await authorization.policyFromRepository({ cwd: repo, gh: transport })
    : null
  for (const pr of prs) {
    if (await pullRequestArmed(repo, pr, policy, transport)) armed.add(pr.number)
  }
  return armed
}
