import { nativeComment, wire } from '../adapters/__tests__/github-workflow-support.ts'
import { buildRecord } from '../dist/contracts.js'
import { sisterRecords } from './cause-input-fixture.ts'

type NativeComment = { id: number; body: string; user: { login: string }; created_at: string; updated_at: string }

export function seedHistoricalChild(
  issues: Map<number, { parent: number | null }>,
  comments: Map<number, NativeComment[]>,
): void {
  const held = sisterRecords().held
  if (held.kind !== 'cause-disposition') throw new Error('expected historical cause')
  const report = buildRecord({
    version: 1,
    repository: held.repository,
    target: held.target,
    recordId: 'historical-child-report',
    runId: 'historic',
    operationId: 'historical-child-report-op',
    kind: 'cause-disposition',
    payload: {
      ...held.payload,
      outcome: { state: 'final', disposition: 'report', blocking: false, reason: 'Retained historical work' },
    },
  })
  if (!report.ok) throw new Error('invalid historical report')
  const child = issues.get(42)
  const ledger = comments.get(42)
  if (!child || !ledger) throw new Error('missing historical child')
  child.parent = 41
  ledger.push(nativeComment(1, wire(report.value)))
}
