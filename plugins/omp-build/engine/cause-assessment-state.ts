import type { resolveCauseActionInputs } from './cause-adjudication.ts'
import type { assessCauseAdjudication } from './cause-adjudication-assessment.ts'
import type { appendUnassignedOutcomes } from './cause-retained-findings.ts'
import type { CauseValidationFrame } from './cause-validation-frame.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'

type Assigned = Parameters<typeof appendUnassignedOutcomes>[0]
export type AssessmentState = Assigned & {
  context: Parameters<typeof assessCauseAdjudication>[0]['context']
  histories: readonly DecodedHistory[]
  catalogues: ReviewClassCatalogues
  adjudications: Parameters<typeof assessCauseAdjudication>[0]['adjudications']
  validatedPrefix?: Parameters<typeof assessCauseAdjudication>[0]['validatedPrefix']
  validationFrame?: CauseValidationFrame
  history: DecodedHistory
  selectedInputs: Extract<ReturnType<typeof resolveCauseActionInputs>, { ok: true }>['value']
  executableCauseIds: string[]
  diagnostics: Diagnostic[]
  claimDiagnostics: ReadonlyMap<string, Diagnostic[]>
}
