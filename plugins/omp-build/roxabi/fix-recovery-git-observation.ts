import { createHash } from 'node:crypto'
import type { FixRecoveryObservation } from '../engine/fix-recovery-control-schema.ts'
import { createCorrectionGitState, isSha, remoteRefSHA } from './correction-git-state.ts'
import type { FixActionResult, PreparedFix } from './fix-contract.ts'
import { failure } from './fix-contract.ts'

/** Live Git facts under the current owner/cohort; never asserts helper or ambient process death. */
export async function observeRecoveryGit(
  prepared: Pick<PreparedFix, 'cwd' | 'publishBinding' | 'target'>,
): Promise<FixActionResult<FixRecoveryObservation['local']>> {
  const expected = prepared.target.candidateGitSHA
  if (expected === null) return failure('fix-head-mismatch')
  const git = createCorrectionGitState({ prepared }, () => expected)
  const before = await git.validatePublishBinding(expected)
  if (!before.ok) return failure(...before.diagnostics)
  try {
    const [head, status, remote] = await Promise.all([
      git.run(['rev-parse', 'HEAD']),
      git.run(['status', '--porcelain']),
      git.run(['ls-remote', '--refs', prepared.publishBinding.pushUrl, prepared.publishBinding.destinationRef]),
    ])
    const headSha = head.stdout.trim()
    const remoteHead = remoteRefSHA(remote.stdout, prepared.publishBinding.destinationRef)
    if (
      !isSha(headSha) ||
      headSha !== expected ||
      remoteHead === undefined ||
      remoteHead !== prepared.publishBinding.expectedRemoteSHA
    )
      return failure('fix-recovery-git-state-changed')
    const after = await git.validatePublishBinding(headSha)
    if (!after.ok) return failure(...after.diagnostics)
    const afterStatus = await git.run(['status', '--porcelain'])
    if (afterStatus.stdout !== status.stdout) return failure('fix-recovery-git-state-changed')
    return {
      ok: true,
      value: {
        head: headSha,
        remoteHead,
        statusDigest: createHash('sha256').update(status.stdout, 'utf8').digest('hex'),
        clean: status.stdout.trim() === '',
        status: { format: 'git-status-porcelain-v1', stdout: status.stdout },
      },
    }
  } catch (error) {
    return failure('fix-recovery-git-unreadable', error instanceof Error ? error.message : String(error))
  }
}
