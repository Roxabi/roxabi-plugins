import { createHash } from 'node:crypto'
import type { Gh } from '../adapters/github/types.ts'
import type { CanonicalRecord, DecodedHistory } from '../dist/contracts.js'
import type { PinnedFileRef } from '../engine/action-input-refs.ts'
import { fixRecoveryDecisionCatalogueRefs } from '../engine/fix-recovery-catalogues.ts'
import { parseReviewClassCatalogue } from '../engine/review-class-catalogue.ts'
import type { FixActionResult } from './fix-contract.ts'
import { failure, recoveryDiagnosticStrings } from './fix-contract.ts'
import { readGitFileBytes } from './uw-git-bytes.ts'

/** Capture exact authenticated pinned bytes, not reconstructed class names. */
export async function readRecoveryCatalogue(input: {
  ref: PinnedFileRef
  cwd: string
  gh: Gh
}): Promise<FixActionResult<{ ref: PinnedFileRef; contents: string }>> {
  const read = await readGitFileBytes({ ...input.ref, cwd: input.cwd, gh: input.gh })
  if (!read.ok) return failure(...recoveryDiagnosticStrings(read.diagnostics))
  if (createHash('sha256').update(read.value).digest('hex') !== input.ref.digest)
    return failure('fix-recovery-catalogue-digest-mismatch')
  let contents: string
  try {
    contents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.value)
  } catch {
    return failure('fix-recovery-catalogue-invalid-utf8')
  }
  if (!parseReviewClassCatalogue(contents).ok) return failure('fix-recovery-catalogue-invalid')
  return { ok: true, value: { ref: { ...input.ref }, contents } }
}

/** Derive precisely the decision's authenticated source pins, then read each pinned blob. */
export async function readRecoveryDecisionCatalogues(input: {
  decision: Extract<CanonicalRecord, { kind: 'decision' }>
  history: DecodedHistory
  cwd: string
  gh: Gh
}): Promise<FixActionResult<{ ref: PinnedFileRef; contents: string }[]>> {
  const refs = fixRecoveryDecisionCatalogueRefs(input)
  if (!refs.ok) return failure(...recoveryDiagnosticStrings(refs.diagnostics))
  const reads = await Promise.all(refs.value.map((ref) => readRecoveryCatalogue({ ref, cwd: input.cwd, gh: input.gh })))
  const failed = reads.find((read) => !read.ok)
  if (failed !== undefined && !failed.ok) return failed
  return { ok: true, value: reads.flatMap((read) => (read.ok ? [read.value] : [])) }
}
