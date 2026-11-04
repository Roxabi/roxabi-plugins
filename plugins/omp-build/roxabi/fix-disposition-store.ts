import {
  type CanonicalRecord,
  type DecodedHistory,
  decodeHistory,
  type GitHubOptions,
  publishGitHubRecord,
  type Result,
  readGitHubHistory,
  type Scope,
  validateCauseDispositionRecords,
  type WorkflowPublication,
} from '../dist/contracts.js'
import { withRoxabiGitHubPolicy } from './github-policy'

export type FixDispositionStore = {
  read(scopes: readonly Scope[]): Promise<Result<readonly DecodedHistory[]>>
  publish(
    record: Extract<CanonicalRecord, { kind: 'cause-disposition' }>,
    histories: readonly DecodedHistory[],
  ): Promise<WorkflowPublication>
}

/** The original UW is the only writable scope; the adapter confirms native readback. */
export function createFixDispositionStore(original: Scope, supplied: GitHubOptions): FixDispositionStore {
  const options = withRoxabiGitHubPolicy(supplied)
  return {
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
      const records = history.operations.flatMap((operation) =>
        operation.status === 'complete' && operation.authority !== 'foreign' && operation.record !== null
          ? [operation.record]
          : [],
      )
      const linked = [
        history,
        ...histories.filter(
          (external) =>
            external.source.scope.repository !== original.repository ||
            external.source.scope.target !== original.target,
        ),
      ]
      const diagnostics = validateCauseDispositionRecords({ records: [...records, record], histories: linked })
      if (diagnostics.length > 0) return { status: 'refused', history, diagnostics }
      return publishGitHubRecord(
        record,
        history,
        options,
        null,
        histories.filter(
          (external) =>
            external.source.scope.repository !== original.repository ||
            external.source.scope.target !== original.target,
        ),
      )
    },
  }
}
