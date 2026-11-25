import { createHash } from 'node:crypto'
import { recordGitPinBytes } from '../engine/historical-git-pins.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { fixtureGitBlobGhResponse } from './action-input-fixtures.ts'
import { causeFixtureScope } from './cause-input-specification.ts'

const causeEvidenceBytes = Buffer.from('export const reloadKeepsSelectedRegion = true\n')
export const causeEvidence = {
  source: 'git-file' as const,
  repository: causeFixtureScope.repository,
  commit: '1'.repeat(40),
  path: 'src/region.ts',
  digest: createHash('sha256').update(causeEvidenceBytes).digest('hex'),
}

export function observeCauseFixtureEvidence(history: DecodedHistory) {
  recordGitPinBytes(history, [causeEvidence], causeEvidenceBytes)
  return history
}

export function fixtureCauseGhResponse(args: readonly string[]): string | null {
  return fixtureGitBlobGhResponse(args, causeEvidence, causeEvidenceBytes)
}
