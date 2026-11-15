import { expect, it } from 'vitest'
import { fixtureUwOperations } from '../testing/action-input-fixtures.ts'
import { nativeCorrectionRecords } from '../testing/native-correction-records.ts'
import type { FixIdentity, PreparedFix, RecordPublisher } from './fix-contract.ts'
import { prepareCorrectionSynthesis } from './fix-contributions-synthesis.ts'

it('rejects another root’s source before preparing or publishing a synthesis', async () => {
  const source = nativeCorrectionRecords().find(
    (record) => record.kind === 'contribution' && record.payload.inventoryId !== null,
  )
  if (source?.kind !== 'contribution' || source.payload.inventoryId === null) throw new Error('native-source-missing')
  const prepared = { inventoryId: 'different-root' } as PreparedFix
  const unexpected = (): never => {
    throw new Error('guard-dispatched-or-published')
  }
  const identity: FixIdentity = { runId: 'run', operationId: 'operation', nextRecordId: unexpected }
  const publisher: RecordPublisher = { publish: async () => unexpected() }
  const operations = fixtureUwOperations(async () => unexpected())
  const result = await prepareCorrectionSynthesis(
    prepared,
    identity,
    publisher,
    [source],
    { name: 'synthesis', agent: 'reviewer', task: 'synthesize', solutionSpace: 'bounded' },
    operations,
    [],
  )
  expect(result).toEqual({ ok: false, diagnostics: ['correction-synthesis-sources-invalid'] })
})
