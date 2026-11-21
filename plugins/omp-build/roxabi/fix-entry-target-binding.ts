import type { Destination } from '../contracts.ts'
import type { Json } from '../dist/contracts.js'
import type { FixActionResult, FixTarget, PublishBinding } from './fix-contract.ts'
import { fail, type Gh, git, object, sha } from './fix-entry-target-core.ts'
import { credentialFreePushUrl } from './fix-publish-url.ts'

type RepositoryDefault = { repository: string; defaultBranch: string; authority: string }

async function readRepositoryDefault(
  cwd: string,
  gh: Gh,
  reference: string,
  expectedRepository: string | null,
  diagnostic: string,
): Promise<FixActionResult<RepositoryDefault>> {
  const repo = object(
    JSON.parse(await gh(cwd, ['repo', 'view', reference, '--json', 'nameWithOwner,defaultBranchRef,url'])),
  )
  const defaultBranch = object(repo?.defaultBranchRef)?.name
  const canonicalUrl = typeof repo?.url === 'string' ? new URL(repo.url) : null
  if (
    repo === null ||
    typeof repo.nameWithOwner !== 'string' ||
    (expectedRepository !== null && repo.nameWithOwner !== expectedRepository) ||
    typeof defaultBranch !== 'string' ||
    defaultBranch.length === 0 ||
    typeof repo.url !== 'string' ||
    !/^https:\/\/[^/?#@]+\/[^?#]*$/.test(repo.url) ||
    canonicalUrl === null ||
    canonicalUrl.protocol !== 'https:' ||
    canonicalUrl.host.length === 0 ||
    canonicalUrl.username !== '' ||
    canonicalUrl.password !== '' ||
    canonicalUrl.search !== '' ||
    canonicalUrl.hash !== '' ||
    canonicalUrl.pathname !== `/${repo.nameWithOwner}`
  ) {
    return fail(diagnostic)
  }
  return { ok: true, value: { repository: repo.nameWithOwner, defaultBranch, authority: canonicalUrl.host } }
}

async function readCurrentBranch(cwd: string): Promise<FixActionResult<{ ref: string; branch: string }>> {
  let ref: string
  try {
    ref = await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'])
  } catch {
    return fail('fix-publish-branch-detached')
  }
  if (!ref.startsWith('refs/heads/') || ref === 'refs/heads/') return fail('fix-publish-branch-detached')
  return { ok: true, value: { ref, branch: ref.slice('refs/heads/'.length) } }
}

async function readPullRequestBinding(
  cwd: string,
  gh: Gh,
  target: FixTarget,
  localRef: string,
  localHead: string,
): Promise<FixActionResult<{ repository: string; destinationRef: string; facts: Json }>> {
  const pr = object(
    JSON.parse(
      await gh(cwd, [
        'pr',
        'view',
        String(target.number),
        '--json',
        'state,headRefOid,headRefName,headRepository,baseRefName',
      ]),
    ),
  )
  const headRepository = object(pr?.headRepository)?.nameWithOwner
  const headRefOid = pr?.headRefOid
  const headRefName = pr?.headRefName
  const baseRefName = pr?.baseRefName
  if (
    pr === null ||
    pr.state !== 'OPEN' ||
    typeof headRefOid !== 'string' ||
    headRefOid !== localHead ||
    typeof headRefName !== 'string' ||
    `refs/heads/${headRefName}` !== localRef ||
    typeof headRepository !== 'string' ||
    typeof baseRefName !== 'string' ||
    baseRefName.length === 0
  ) {
    return fail('fix-publish-pr-binding-mismatch')
  }
  return {
    ok: true,
    value: {
      repository: headRepository,
      destinationRef: `refs/heads/${headRefName}`,
      facts: { headRefOid, headRefName, headRepository, baseRefName },
    },
  }
}

function expectedRemoteSha(remoteLine: string, destinationRef: string): FixActionResult<string | null> {
  if (remoteLine === '') return { ok: true, value: null }
  const fields = remoteLine.split(/\s+/)
  const remoteSHA = fields.length === 2 && fields[1] === destinationRef ? sha(fields[0] ?? '') : null
  return remoteSHA === null ? fail('fix-publish-remote-ref-unreadable') : { ok: true, value: remoteSHA }
}

export async function resolvePublishBinding(
  cwd: string,
  gh: Gh,
  repository: string,
  target: FixTarget,
): Promise<FixActionResult<PublishBinding & { destination: Destination }>> {
  try {
    const base = await readRepositoryDefault(cwd, gh, repository, repository, 'fix-publish-default-branch-unreadable')
    if (!base.ok) return base
    const branch = await readCurrentBranch(cwd)
    if (!branch.ok) return branch
    const localHead = sha(await git(cwd, ['rev-parse', '--verify', 'HEAD']))
    if (localHead === null || localHead !== target.candidateGitSHA) return fail('fix-publish-local-head-mismatch')
    const pushUrl = await git(cwd, ['remote', 'get-url', '--push', 'origin'])
    if (!credentialFreePushUrl(pushUrl)) return fail('fix-publish-remote-credential-refused')
    const remote = await readRepositoryDefault(cwd, gh, pushUrl, null, 'fix-publish-remote-repository-mismatch')
    if (!remote.ok) return remote
    if (remote.value.authority !== base.value.authority) return fail('fix-publish-remote-repository-mismatch')
    const pullRequest = await readPullRequestBinding(cwd, gh, target, branch.value.ref, localHead)
    if (!pullRequest.ok) return pullRequest
    if (remote.value.repository !== pullRequest.value.repository) return fail('fix-publish-remote-repository-mismatch')
    if (branch.value.branch === remote.value.defaultBranch) return fail('fix-publish-default-branch-refused')
    const remoteLine = await git(cwd, ['ls-remote', '--refs', pushUrl, pullRequest.value.destinationRef])
    const expectedSHA = expectedRemoteSha(remoteLine, pullRequest.value.destinationRef)
    if (!expectedSHA.ok) return expectedSHA
    if (expectedSHA.value !== localHead) return fail('fix-publish-remote-head-mismatch')
    return {
      ok: true,
      value: {
        pushUrl,
        publicationRepository: pullRequest.value.repository,
        localBranch: branch.value.branch,
        destinationRef: pullRequest.value.destinationRef,
        destination: {
          authority: remote.value.authority,
          publicationRepository: remote.value.repository,
          destinationRef: pullRequest.value.destinationRef,
        },
        localHead,
        expectedRemoteSHA: expectedSHA.value,
        defaultBranch: remote.value.defaultBranch,
        observed: {
          target: target.target,
          baseRepository: repository,
          baseDefaultBranch: base.value.defaultBranch,
          localRef: branch.value.ref,
          localHead,
          pushUrl,
          remoteRepository: remote.value.repository,
          remoteDefaultBranch: remote.value.defaultBranch,
          remoteLine,
          pr: pullRequest.value.facts,
        },
      },
    }
  } catch (error) {
    return fail(`fix-publish-binding-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
}
