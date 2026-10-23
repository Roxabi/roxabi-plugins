import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

import { decision } from '../../testing/records.ts'

const ompBuildRoot = fileURLToPath(new URL('../..', import.meta.url))

describe('producer JSON schema SDK compatibility', () => {
  test('validates generated decision schemas and representative retained-finding payloads in real Bun', () => {
    const unusable = decision({
      findings: [
        {
          id: 'unusable-final',
          label: 'issue(blocking)' as const,
          impactReason: 'Captured source lacks required fields.',
          state: 'unusable' as const,
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
          sourceFindingIds: ['source:f0', 'source:f1'],
          description: 'Keep both reports visible.',
          mergeReason: 'Both reports name the same correction.',
        },
      ],
    }).payload.judgment
    const program = [
      "import { isJsonSchemaValueValid, isValidJsonSchema } from '@oh-my-pi/pi-ai/utils/schema'",
      "import { producerJsonSchema } from './dist/contracts.js'",
      `const schema = producerJsonSchema('decision')`,
      `const values = ${JSON.stringify([unusable, usableMerged])}`,
      'console.log(JSON.stringify({ schema: isValidJsonSchema(schema), values: values.map((value) => isJsonSchemaValueValid(schema, value)) }))',
    ].join('\n')

    const result = JSON.parse(execFileSync('bun', ['--eval', program], { cwd: ompBuildRoot, encoding: 'utf8' }))
    expect(result).toEqual({ schema: true, values: [true, true] })
  })
})
