import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

import { finding } from '../../testing/record-builders.ts'
import { decision } from '../../testing/record-decisions.ts'

const ompBuildRoot = fileURLToPath(new URL('../..', import.meta.url))

describe('historical decision schema', () => {
  test('accepts representative retained-finding payloads in real Bun', () => {
    const unusable = decision({
      findings: [
        {
          id: 'unusable-final',
          label: 'issue(blocking)' as const,
          impactReason: 'Captured source lacks required fields.',
          state: 'unusable' as const,
          target: null,
          sourceFindingIds: ['source:f0'],
        },
      ],
    }).payload.judgment
    const usableMerged = decision({
      findings: [
        {
          id: 'usable-final',
          label: 'suggestion' as const,
          impactReason: 'The two reports describe one correction.',
          state: 'usable' as const,
          target: finding().target,
          sourceFindingIds: ['source:f0', 'source:f1'],
          description: 'Keep both reports visible.',
          mergeReason: 'Both reports name the same correction.',
        },
      ],
    }).payload.judgment
    const program = [
      "import { decisionSchema } from './engine/review-schema.ts'",
      `const values = ${JSON.stringify([unusable, usableMerged])}`,
      'console.log(JSON.stringify(values.map((value) => decisionSchema.safeParse(value).success)))',
    ].join('\n')

    const result = JSON.parse(execFileSync('bun', ['--eval', program], { cwd: ompBuildRoot, encoding: 'utf8' }))
    expect(result).toEqual([true, true])
  })
})
