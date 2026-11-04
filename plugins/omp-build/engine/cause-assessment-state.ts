import type { resolveCauseActionInputs } from './cause-adjudication.ts'
import type { assessCauseAdjudication } from './cause-adjudication-assessment.ts'
import type { appendUnassignedOutcomes } from './cause-retained-findings.ts'
import type { DecodedHistory } from './history-schema.ts'

type Assigned = Parameters<typeof appendUnassignedOutcomes>[0]
export type AssessmentState = Assigned & {
  context: Parameters<typeof assessCauseAdjudication>[0]['context']
  histories: readonly DecodedHistory[]
  adjudications: Parameters<typeof assessCauseAdjudication>[0]['adjudications']
  history: DecodedHistory
  selectedInputs: Extract<ReturnType<typeof resolveCauseActionInputs>, { ok: true }>['value']
  executableCauseIds: string[]
  diagnostics: import('./record-values.ts').Diagnostic[]
}
