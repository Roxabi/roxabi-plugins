import type { RecordInputRef } from './action-input-refs.ts'
import type { CodeVersion, CriterionDeclaration } from './criterion-evidence-schema.ts'
import type { CriterionVerdict } from './criterion-verdict-schema.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import type { SpecEffective } from './spec-effective-schema.ts'
import type { UwResult } from './uw-diagnostics.ts'

export type UwDeliveryDeclaration = { value: CriterionDeclaration; code: CodeVersion; receipt: RecordInputRef }
export type UwDeliveryVerdict = { value: CriterionVerdict; code: CodeVersion; source: RecordInputRef }
export type UwDeliveryRead = {
  uw: Scope
  effective: UwResult<SpecEffective>
  declarations: readonly UwDeliveryDeclaration[]
  verdicts: readonly UwDeliveryVerdict[]
  diagnostics: readonly Diagnostic[]
}
