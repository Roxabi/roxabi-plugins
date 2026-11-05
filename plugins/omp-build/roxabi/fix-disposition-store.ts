import {
  type CanonicalRecord,
  type DecodedHistory,
  decodeHistory,
  type GitHubOptions,
  publishGitHubRecord,
  type Result,
  type ReviewClassCatalogues,
  readGitHubHistory,
  type Scope,
  validateCauseDispositionRecords,
  type WorkflowPublication,
} from '../dist/contracts.js'
import { defaultGh } from './feature-engine.ts'
import { withRoxabiGitHubPolicy } from './github-policy'
import { createPublicationContextResolver } from './publication-context.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'

export type FixDispositionStore = {
  read(scopes: readonly Scope[]): Promise<Result<readonly DecodedHistory[]>>
  catalogues(histories: readonly DecodedHistory[]): Promise<ReviewClassCatalogues>
  publish(
    record: Extract<CanonicalRecord, { kind: 'cause-disposition' }>,
    histories: readonly DecodedHistory[],
  ): Promise<WorkflowPublication>
}

/** The original UW is the only writable scope; the adapter confirms native readback. */
export function createFixDispositionStore(original: Scope, supplied: GitHubOptions): FixDispositionStore {
  const options = withRoxabiGitHubPolicy(supplied)
  return {
    catalogues(histories) {
      return loadReviewClassCatalogues({ histories, cwd: options.cwd, gh: options.gh ?? defaultGh() })
    },
    async read(scopes) {
      try {
        const histories = await Promise.all(
          scopes.map(async (scope) => decodeHistory(await readGitHubHistory(scope, options))),
        )
        if (histories.some((history) => !history.source.complete))
          return {
            ok: false,
            diagnostics: [
              {
                code: 'correction-disposition-history-incomplete',
                message: 'Disposition source history is incomplete',
              },
            ],
          }
        return { ok: true, value: histories }
      } catch (error) {
        return {
          ok: false,
          diagnostics: [
            {
              code: 'correction-disposition-history-unreadable',
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        }
      }
    },
    async publish(record, histories) {
      const history = decodeHistory(await readGitHubHistory(original, options))
      if (record.repository !== original.repository || record.target !== original.target)
        return {
          status: 'refused',
          history,
          diagnostics: [{ code: 'correction-origin-mismatch', message: 'Disposition is not on the original UW' }],
        }
      const resolver = createPublicationContextResolver(options, null)
      const context = await resolver({ record, history, externalHistories: histories })
      if (!context.ok) return { status: 'refused', history, diagnostics: context.diagnostics }
      if (context.value.config === null)
        return {
          status: 'refused',
          history,
          diagnostics: [
            {
              code: 'correction-disposition-catalogue-missing',
              message: 'Disposition publication requires catalogue evidence',
            },
          ],
        }
      const linked = [history, ...context.value.externalHistories]
      const records = history.operations.flatMap((operation) =>
        operation.status === 'complete' && operation.authority !== 'foreign' && operation.record !== null
          ? [operation.record]
          : [],
      )
      const diagnostics = validateCauseDispositionRecords({
        records: [...records, record],
        histories: linked,
        catalogues: context.value.config.catalogues,
      })
      if (diagnostics.length > 0) return { status: 'refused', history, diagnostics }
      return publishGitHubRecord(record, options, resolver, context.value.externalHistories)
    },
  }
}
