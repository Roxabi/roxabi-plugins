import type { Diagnostic, Scope } from './record-values.ts'
import type { AcceptedSpec } from './workflow-accepted-spec-types.ts'
import type { MandateRecord } from './workflow-control.ts'
import type { LandingRefusal } from './workflow-landing.ts'
import type { MandateRefusal } from './workflow-mandate.ts'

export type ConfigIdentity = {
  productVersion: string
  version: string
  digest: string
  additionalRequirements: readonly string[]
  serialized: string
}

export type MandateUse = 'review' | 'correction' | 'landing'

export type BoundWork =
  | {
      status: 'applicable'
      binding: 'bound'
      mandate: MandateRecord
      scope: Scope
      permissions: { landing: boolean; correct: boolean }
      acceptedSpec: AcceptedSpec
      configIdentity: ConfigIdentity
      drift: 'settled' | 'differs' | null
    }
  | { status: 'standalone'; binding: 'absent' }
  | { status: 'refused'; reason: MandateRefusal | LandingRefusal; evidence: Diagnostic[] }
