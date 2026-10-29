import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Result } from '../engine/result.ts'
import { repoRelativePathSchema } from '../engine/schema-primitives.ts'
import type { PinnedFileRef, UwActionPorts, UwActionRequest } from './uw-action-contract.ts'
import { actionFailure, sha256Bytes } from './uw-action-result.ts'
import { correctionObservation } from './uw-correction-observation.ts'

const exec = promisify(execFile)

/** Only the already-scoped live request may read its own H2 Git objects locally. */
export function correctionLocalPorts(request: UwActionRequest, ports: UwActionPorts): UwActionPorts {
  const basis = correctionObservation(request)
  if (basis === undefined) return ports
  const localRef = (ref: PinnedFileRef) => ref.repository === request.code.repository && ref.commit === basis.actionHead
  const read = async (ref: PinnedFileRef): Promise<Result<Uint8Array>> => {
    if (!localRef(ref)) return ports.readPinnedFile(ref)
    if (
      !repoRelativePathSchema.safeParse(ref.path).success ||
      ref.path.split('/').some((part) => part === '.' || part === '..')
    )
      return actionFailure('pinned-file-unreadable', 'Correction Git blob path is invalid')
    try {
      const result = await exec('git', ['-C', basis.cwd, 'cat-file', 'blob', `${ref.commit}:${ref.path}`], {
        encoding: 'buffer',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30_000,
      })
      return sha256Bytes(result.stdout) === ref.digest
        ? { ok: true, value: result.stdout }
        : actionFailure('action-input-stale', `Correction pinned bytes changed: ${ref.path}`)
    } catch {
      return actionFailure('pinned-file-unreadable', `Correction Git blob is unavailable: ${ref.path}`)
    }
  }
  return {
    ...ports,
    readPinnedFile: read,
    readCodeDiff: async (code) => {
      if (
        code.repository !== request.code.repository ||
        code.base !== request.code.base ||
        code.head !== basis.actionHead
      )
        return ports.readCodeDiff(code)
      try {
        const diff = await exec(
          'git',
          ['-C', basis.cwd, 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', code.base, code.head],
          {
            encoding: 'buffer',
            maxBuffer: 32 * 1024 * 1024,
            timeout: 30_000,
          },
        )
        return { ok: true, value: diff.stdout }
      } catch {
        return actionFailure('git-objects-missing', 'Correction diff Git objects are unavailable')
      }
    },
  }
}
