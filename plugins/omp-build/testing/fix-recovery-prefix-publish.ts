import { frameFixRecoveryFixture } from './fix-recovery-prefix-framing.ts'
import { writeSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

/** Seed the simulated external history; this is not an originating native publication. */
export function publishFixRecoveryFixture(input: {
  box: Box
  mode: 'torn-source' | 'torn-request'
  opening: unknown
  settlement: unknown
  date: string
  sourceParts: string[]
  requestBody: string
}) {
  const { box, mode, opening, settlement, date, sourceParts, requestBody } = input
  const sourceBody = sourceParts[0]
  if (sourceBody === undefined) throw new Error('fixture-source-part-missing')
  writeSim(box, (state) => {
    const issue = state.issues['42']
    const pr = state.prs['7']
    if (!issue || !pr) throw new Error('fixture-scope-missing')
    issue.comments.push(
      ...frameFixRecoveryFixture(opening).map((body) => ({
        author: 'operator',
        body,
        createdAt: date,
        updatedAt: date,
      })),
    )
    issue.comments.push(
      ...frameFixRecoveryFixture(settlement).map((body) => ({
        author: 'operator',
        body,
        createdAt: date,
        updatedAt: date,
      })),
    )
    if (mode === 'torn-source') {
      pr.comments.push({ id: 9001, author: 'operator', body: sourceBody, createdAt: date, updatedAt: date })
    } else {
      pr.comments.push(
        ...sourceParts.map((body, index) => ({
          id: 9001 + index,
          author: 'operator',
          body,
          createdAt: date,
          updatedAt: date,
        })),
      )
      pr.comments.push({ id: 19001, author: 'operator', body: requestBody, createdAt: date, updatedAt: date })
    }
  })
}
