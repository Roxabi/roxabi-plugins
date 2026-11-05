import { type GitHubOptions, gh as githubClient } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import type { PreparedReviewInputs } from './review-contract'
import { readReviewInputHistories } from './uw-input-readers.ts'

export function reviewEvidenceReaders(input: PreparedReviewInputs, options: GitHubOptions) {
  const gh = githubClient(options)
  return {
    loadCatalogues: (histories: readonly DecodedHistory[]) =>
      loadReviewClassCatalogues({
        histories,
        candidateInputs: [input.inputSnapshot],
        cwd: options.cwd,
        gh,
      }),
    readExternalHistories: (history: DecodedHistory) =>
      readReviewInputHistories(history, {
        cwd: options.cwd,
        gh,
        readAuthor: options.readAuthor,
      }),
  }
}
