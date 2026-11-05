import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { assessAdjudicationSuccessor } from '../cause-adjudication-successor.ts'
import { validateCauseAdjudication, validateCauseDispositionRecords } from '../cause-disposition.ts'
import { recordsOf } from '../workflow-control.ts'
import { cataloguesForInputs } from './cause-catalogue-fixture.ts'
import type { lineageFixture } from './cause-lineage-fixture.ts'

const path = process.argv[2]
if (!path) throw new Error('Expected serialized authenticated fixture')
const fixture = JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof lineageFixture>
const histories = [fixture.own, fixture.source]
const catalogues = cataloguesForInputs(fixture.inputs)
assert.deepEqual(validateCauseDispositionRecords({ records: recordsOf(fixture.own), histories, catalogues }), [])
assert.equal(fixture.transitions.length, 16)
assert.deepEqual(
  fixture.transitions.map(({ operation }) => {
    const proposal = operation.payload.proposal
    if (proposal.operation !== 'adjudicate-cause') throw new Error('Expected adjudication')
    return proposal.rejectedFindingIds
  }),
  fixture.findings.map((finding) => [finding.id]),
)
const last = fixture.transitions.at(-1)
if (!last) throw new Error('Expected final transition')
assert.deepEqual(fixture.pending, last.next)
const outcome = fixture.pending.payload.outcome
assert.equal(outcome.state, 'final')
if (outcome.state !== 'final') throw new Error('Expected final disposition')
assert.equal(outcome.disposition, 'report')
assert.equal(outcome.blocking, false)
const replay = assessAdjudicationSuccessor({
  pending: last.pending,
  operation: last.operation,
  context: fixture.context,
  histories,
  catalogues,
})
assert.equal(replay.ok, true)
if (!replay.ok) throw new Error('Final successor refused')
assert.deepEqual(replay.value, fixture.pending.payload)
const proposal = last.operation.payload.proposal
if (proposal.operation !== 'adjudicate-cause') throw new Error('Expected adjudication')
const competing = validateCauseAdjudication({
  proposal: { ...proposal, operationId: 'competing-intent' },
  pending: last.pending,
  context: fixture.context,
  histories,
})
assert.ok(competing.some((diagnostic) => diagnostic.code === 'cause-adjudication-ambiguous'))
const stale = validateCauseAdjudication({ proposal, pending: fixture.pending, context: fixture.context, histories })
assert.ok(stale.some((diagnostic) => diagnostic.code === 'cause-adjudication-pending-mismatch'))
process.stdout.write('authenticated-lineage-ok\n')
