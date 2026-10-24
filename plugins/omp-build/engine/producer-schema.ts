import { z } from 'zod'
import { diagnostic } from './record-diagnostics.ts'
import {
  actionResultSchema,
  type Diagnostic,
  findingReportSchema,
  findingSchema,
  type Json,
  type Label,
  specReportSchema,
} from './record-values.ts'
import type { FindingInspection } from './result.ts'
import { decisionSchema } from './review-schema.ts'
import {
  ciAttributionSchema,
  implementationOutputSchema,
  planOutputSchema,
  planReviewSchema,
  specAssessmentSchema,
} from './workflow-output-schema.ts'

export const PRODUCER_OUTPUTS = [
  'spec',
  'findings',
  'decision',
  'action-result',
  'spec-assessment',
  'plan',
  'plan-review',
  'implementation',
  'ci-attribution',
] as const
export type ProducerOutput = (typeof PRODUCER_OUTPUTS)[number]

const producerSchemas = {
  spec: specReportSchema,
  findings: findingReportSchema,
  decision: decisionSchema,
  'action-result': actionResultSchema,
  'spec-assessment': specAssessmentSchema,
  plan: planOutputSchema,
  'plan-review': planReviewSchema,
  implementation: implementationOutputSchema,
  'ci-attribution': ciAttributionSchema,
} as const satisfies Record<ProducerOutput, z.ZodType>

export function producerJsonSchema(output: string): Json {
  if (!Object.hasOwn(producerSchemas, output)) {
    throw new Error(`producerJsonSchema has no output ${output}`)
  }
  const schema = producerSchemas[output as ProducerOutput]
  return JSON.parse(JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12' })))
}

function knownLabelFromMalformedFinding(data: Json): Label | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data) || typeof data.label !== 'string') return null
  return labelIsKnown(data.label) ? data.label : null
}

export function inspectFinding(data: Json, taxonomy: readonly string[]): FindingInspection {
  const parsed = findingSchema.safeParse(data)
  if (!parsed.success) {
    return {
      usable: false,
      knownLabel: knownLabelFromMalformedFinding(data),
      diagnostics: [diagnostic('unusable-finding', 'Original finding is not a strict canonical finding')],
    }
  }
  const diagnostics: Diagnostic[] = []
  const candidateClasses = (parsed.data.classes ?? []).filter((findingClass) => findingClass.startsWith('candidate/'))
  if (candidateClasses.length > 1)
    diagnostics.push(diagnostic('unusable-finding', 'Finding has more than one advisory candidate class'))
  for (const findingClass of candidateClasses)
    if (!/^candidate\/[a-z][a-z0-9-]{1,48}$/.test(findingClass))
      diagnostics.push(diagnostic('unknown-reference', `Candidate class ${findingClass} is malformed`))
  for (const findingClass of parsed.data.classes ?? []) {
    if (!findingClass.startsWith('candidate/') && !taxonomy.includes(findingClass))
      diagnostics.push(
        diagnostic('unknown-reference', `Finding class ${findingClass} is not in the canonical taxonomy`),
      )
  }
  if ((parsed.data.classes?.length ?? 0) > 0 && (parsed.data.rawCallsites?.length ?? 0) === 0)
    diagnostics.push(diagnostic('unusable-finding', 'Classified finding is missing raw callsites'))
  return { usable: diagnostics.length === 0, knownLabel: parsed.data.label, diagnostics }
}

function labelIsKnown(value: string): value is Label {
  return [
    'issue',
    'issue(blocking)',
    'todo',
    'suggestion(blocking)',
    'suggestion',
    'suggestion(non-blocking)',
    'nitpick',
    'thought',
    'question',
    'praise',
  ].includes(value)
}
