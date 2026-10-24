import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { promisify } from 'node:util'

import type { Json } from '../dist/contracts.js'
import { failed, repoRelativePath } from './correction-action'
import type { CorrectionEffectResult, NativeCorrectionExecutionOptions } from './correction-execution-contract'
import type { PublishBinding } from './fix-contract'

const execFileAsync = promisify(execFile)

export type CorrectionGitState = {
  run(args: readonly string[]): Promise<{ stdout: string; stderr: string }>
  cleanHead(): Promise<CorrectionEffectResult<{ head: string }>>
  expectedCleanHead(): Promise<CorrectionEffectResult<{ head: string }>>
  validatePublishBinding(head: string): Promise<CorrectionEffectResult<PublishBinding>>
  verifyOwnedCommit(
    commit: string,
    parent: string,
    causeScopePaths: readonly string[],
    proofPaths: readonly string[],
  ): Promise<CorrectionEffectResult<Json>>
}

export function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value)
}

function headRef(ref: string): boolean {
  return /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes('..') && !ref.endsWith('/')
}

function remoteRefSHA(stdout: string, ref: string): string | null | undefined {
  const lines = stdout.trim() === '' ? [] : stdout.trim().split('\n')
  if (lines.length === 0) return null
  if (lines.length !== 1) return undefined
  const [sha, actualRef] = lines[0]?.split('\t') ?? []
  return sha !== undefined && actualRef === ref && isSha(sha) ? sha : undefined
}

function sameOrDescendant(path: string, scope: string): boolean {
  return path === scope || path.startsWith(`${scope}/`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createCorrectionGitState(
  options: Pick<NativeCorrectionExecutionOptions, 'prepared'>,
  expectedHead: () => string | null,
): CorrectionGitState {
  let repositoryChecked: Promise<CorrectionEffectResult<void>> | null = null
  const run = async (args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
    const output = await execFileAsync('git', [...args], {
      cwd: options.prepared.cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    return { stdout: String(output.stdout), stderr: String(output.stderr) }
  }
  const assertRepository = (): Promise<CorrectionEffectResult<void>> => {
    if (repositoryChecked !== null) return repositoryChecked
    repositoryChecked = (async () => {
      try {
        const configured = realpathSync(options.prepared.cwd)
        const root = await run(['rev-parse', '--show-toplevel'])
        return realpathSync(root.stdout.trim()) === configured
          ? { ok: true, value: undefined }
          : failed('terminal', 'correction-cwd-is-not-repository-root')
      } catch (error) {
        return failed('terminal', `correction-repository-unreadable:${errorMessage(error)}`)
      }
    })()
    return repositoryChecked
  }
  const cleanHead = async (): Promise<CorrectionEffectResult<{ head: string }>> => {
    const repository = await assertRepository()
    if (!repository.ok) return repository
    try {
      const [head, status] = await Promise.all([run(['rev-parse', 'HEAD']), run(['status', '--porcelain'])])
      const current = head.stdout.trim()
      return status.stdout.trim() === '' && isSha(current)
        ? { ok: true, value: { head: current } }
        : failed('terminal', 'fix-worktree-not-clean')
    } catch (error) {
      return failed('terminal', `fix-git-state-unreadable:${errorMessage(error)}`)
    }
  }
  const expectedCleanHead = async (): Promise<CorrectionEffectResult<{ head: string }>> => {
    const state = await cleanHead()
    return !state.ok || state.value.head === expectedHead() ? state : failed('terminal', 'fix-head-mismatch')
  }
  const validatePublishBinding = async (head: string): Promise<CorrectionEffectResult<PublishBinding>> => {
    const publish = options.prepared.publishBinding
    const target = options.prepared.target
    const localRef = `refs/heads/${publish.localBranch}`
    const defaultRef = `refs/heads/${publish.defaultBranch}`
    if (
      !isSha(head) ||
      target.candidateGitSHA === null ||
      !isSha(target.candidateGitSHA) ||
      !headRef(localRef) ||
      !headRef(publish.destinationRef) ||
      !headRef(defaultRef) ||
      publish.destinationRef !== localRef ||
      localRef === defaultRef ||
      !isSha(publish.localHead) ||
      publish.localHead !== target.candidateGitSHA ||
      (publish.expectedRemoteSHA !== null && !isSha(publish.expectedRemoteSHA))
    )
      return failed('terminal', 'publish-binding-invalid')
    const repository = await assertRepository()
    if (!repository.ok) return repository
    try {
      const [symbolicHead, branchHead, effectivePushURL, remote] = await Promise.all([
        run(['symbolic-ref', '--quiet', 'HEAD']),
        run(['rev-parse', localRef]),
        run(['remote', 'get-url', '--push', 'origin']),
        run(['ls-remote', '--refs', publish.pushUrl, publish.destinationRef]),
      ])
      const observedRemoteSHA = remoteRefSHA(remote.stdout, publish.destinationRef)
      return symbolicHead.stdout.trim() !== localRef ||
        branchHead.stdout.trim() !== head ||
        effectivePushURL.stdout.trim() !== publish.pushUrl ||
        observedRemoteSHA !== publish.expectedRemoteSHA
        ? failed('terminal', 'publish-binding-stale')
        : { ok: true, value: publish }
    } catch (error) {
      return failed('terminal', `publish-binding-unverified:${errorMessage(error)}`)
    }
  }
  const verifyOwnedCommit = async (
    commit: string,
    parent: string,
    causeScopePaths: readonly string[],
    proofPaths: readonly string[],
  ): Promise<CorrectionEffectResult<Json>> => {
    try {
      if (proofPaths.some((path) => !repoRelativePath(path)))
        return failed('terminal', 'native-apply-proof-paths-invalid')
      const [head, resolved, parents, changed, status] = await Promise.all([
        run(['rev-parse', 'HEAD']),
        run(['rev-parse', '--verify', `${commit}^{commit}`]),
        run(['rev-list', '--parents', '-n1', commit]),
        run(['diff-tree', '--no-commit-id', '--name-only', '-r', commit]),
        run(['status', '--porcelain']),
      ])
      const parentTokens = parents.stdout.trim().split(/\s+/)
      const allowedPaths = [...causeScopePaths, ...proofPaths]
      const changedPaths = changed.stdout.split('\n').filter(Boolean)
      const valid =
        parentTokens.length === 2 &&
        parentTokens[0] === commit &&
        parentTokens[1] === parent &&
        changedPaths.length > 0 &&
        changedPaths.every((path) => allowedPaths.some((scope) => sameOrDescendant(path, scope)))
      if (head.stdout.trim() !== commit || resolved.stdout.trim() !== commit || !valid || status.stdout.trim() !== '')
        return failed('terminal', 'native-apply-git-state-unverified')
      return {
        ok: true,
        value: {
          head: head.stdout,
          commit: resolved.stdout,
          parent: parents.stdout,
          changed: changed.stdout,
          proofPaths: [...proofPaths],
        },
      }
    } catch (error) {
      return failed('terminal', `native-apply-proof-unverified:${errorMessage(error)}`)
    }
  }
  return { run, cleanHead, expectedCleanHead, validatePublishBinding, verifyOwnedCommit }
}

export { remoteRefSHA }
