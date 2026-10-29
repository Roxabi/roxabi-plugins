import { describe, expect, test } from 'vitest'
import { producerJsonSchema } from '../producer-schema.ts'
import { implementationOutputSchema, producerImplementationOutputSchema } from '../workflow-output-schema.ts'
import { criterionTarget } from './criterion-admission-fixture.ts'

const tip = 'a'.repeat(40)

function citation() {
  const target = criterionTarget('C1')
  return {
    outcome: 'implemented' as const,
    commitSHAs: [tip],
    commands: [{ toolCallId: 'actual-call', command: 'bun test src/region.test.ts', exitCode: 0 }],
    criteria: [
      {
        target,
        verification: 'evidence' as const,
        evidence: [
          {
            id: 'evidence-reload',
            method: 'test' as const,
            scenario: 'reload keeps the selected region',
            target,
            after: {
              toolCallId: 'actual-call',
              versionClaim: {
                code: { repository: 'acme/app', commit: tip },
                reason: 'cited captured run',
                references: [],
              },
            },
            before: null,
          },
        ],
      },
    ],
    reason: 'implemented',
  }
}

describe('implementation producer schema', () => {
  test('admits an ID-only test citation that the durable receipt still rejects', () => {
    const claim = citation()
    expect(producerImplementationOutputSchema.safeParse(claim).success).toBe(true)
    expect(implementationOutputSchema.safeParse(claim).success).toBe(false)
    const form = JSON.stringify(producerJsonSchema('implementation'))
    expect(form).not.toContain('proofToolCallId')
    expect(form).not.toContain('proofUnavailableReason')
    expect(form).toContain('toolCallId')
    expect(form).not.toContain('"cwd"')
  })
})
