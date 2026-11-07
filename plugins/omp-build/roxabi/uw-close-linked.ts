import type { IssueWriteResult } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { canonicalValueDigest } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwOperationResult, UwOperations, UwRead, UwReadPort } from './uw-contract.ts'
import { diagnostic } from './uw-installed-reports.ts'

type CloseLinkedRequest = Parameters<UwOperations['closeLinked']>[0]

type CloseProofRead = { ok: true; read: UwRead } | { ok: false; result: UwOperationResult }

/** Read and compare the completion proof before attempting the native effect. */
export async function readCloseProof(request: CloseLinkedRequest, reader: UwReadPort): Promise<CloseProofRead> {
  let before: UwRead
  try {
    before = await reader.readUw(request.uw)
  } catch (error) {
    return {
      ok: false,
      result: {
        status: 'refused',
        diagnostics: [diagnostic(request.uw, 'close-linked-observation-unavailable', String(error))],
      },
    }
  }
  const completion = before.completion.completions.get(`${request.uw.repository}\0${request.uw.target}`)
  if (
    before.observation.status !== 'complete' ||
    completion?.state !== 'complete' ||
    canonicalValueDigest(completion) !== canonicalValueDigest(request.completion)
  )
    return {
      ok: false,
      result: {
        status: 'refused',
        diagnostics: [
          diagnostic(
            request.uw,
            'close-linked-completion-changed',
            'The fresh common completion proof differs from the landing proof',
          ),
        ],
      },
    }
  return { ok: true, read: before }
}

export function closeWriteFailure(
  uw: Scope,
  written: Exclude<IssueWriteResult, { status: 'written' }>,
): UwOperationResult {
  if (written.status === 'uncertain') return { status: 'uncertain', diagnostics: written.diagnostics }
  const errors = written.diagnostics.map((item) => diagnostic(uw, item.code, item.message))
  return written.status === 'partial'
    ? { status: 'partial', uw, diagnostics: errors }
    : { status: 'refused', diagnostics: errors }
}
