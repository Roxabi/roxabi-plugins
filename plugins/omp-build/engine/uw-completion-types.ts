import type { RecordInputRef } from './action-input-refs.ts'
import type { ActionInputManifest } from './action-input-schema.ts'
import type { Ref } from './cause-disposition.ts'
import type { CodeVersion } from './criterion-evidence-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import type { Scope } from './schema-primitives.ts'
import type { UwDiagnostic } from './uw-diagnostics.ts'
import type { UwGraphObservation } from './uw-graph.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'

type NonEmpty<T> = readonly [T, ...T[]]
export type SpecVersionVector = NonEmpty<OwnSpecRef>

export type NativeDeliveryPullRequest = {
  pullRequest: Scope
  branch: string
  base: string
  head: string
  baseTip: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  mergeCommit: string | null
}
export type ObservedCommit = { code: CodeVersion; parents: readonly string[] }
export type UwDeliveryFacts = {
  uw: Scope
  pullRequests: readonly NativeDeliveryPullRequest[]
  integrations: readonly { source: RecordInputRef; code: ActionInputManifest['code'] }[]
  commits: readonly ObservedCommit[]
}
export type UwObservationFacts = {
  root: Scope
  graph: UwGraphObservation
  histories: readonly DecodedHistory[]
  catalogues: ReviewClassCatalogues
  delivery: readonly UwDeliveryFacts[]
}
export type UwCompletionObservation =
  | (UwObservationFacts & { status: 'complete'; graph: Extract<UwGraphObservation, { status: 'complete' }> })
  | (UwObservationFacts & { status: 'incomplete'; diagnostics: NonEmpty<UwDiagnostic> })

export type WaitRequirement = {
  from: Scope
  to: Scope
  source:
    | { kind: 'native-child' }
    | { kind: 'native-blocker' }
    | { kind: 'accepted-child'; accepted: OwnSpecRef }
    | {
        kind: 'blocking-sister'
        disposition: Ref<'cause-disposition'>
        receipt: Ref<'debt-receipt'>
        control: Ref<'operator-control'> | null
      }
}
export type CauseWaitResolution = {
  origin: Scope
  disposition: Ref<'cause-disposition'>
  receipt: Ref<'debt-receipt'>
} & (
  | { state: 'required'; target: Scope; control: Ref<'operator-control'> | null }
  | { state: 'withdrawn'; control: Ref<'operator-control'> }
  | { state: 'held'; diagnostics: NonEmpty<UwDiagnostic> }
)
export type UwWaitProjection = {
  requirements: readonly WaitRequirement[]
  causeWaits: readonly CauseWaitResolution[]
  requiredScopes: readonly Scope[]
  deliveryScopes: readonly Scope[]
  diagnostics: readonly UwDiagnostic[]
}
export type NativeOnlyAbsenceWitness = {
  uw: Scope
  history: DecodedHistory
  observation: Extract<UwCompletionObservation, { status: 'complete' }>
}
export type DependencyBasis =
  | { kind: 'accepted-uw'; mandate: Ref<'mandate'> }
  | { kind: 'uw-before-mandate'; witnesses: NonEmpty<ExternalRecordRef> }
  | { kind: 'native-only'; witness: NativeOnlyAbsenceWitness }
  | { kind: 'unresolved'; diagnostics: NonEmpty<UwDiagnostic> }
export type UwCompletion =
  | {
      state: 'complete'
      uw: Scope
      role: 'leaf' | 'parent'
      spec: OwnSpecRef
      versionVector: NonEmpty<OwnSpecRef>
      code: ActionInputManifest['code']
      sources: readonly ExternalRecordRef[]
    }
  | { state: 'not-complete' | 'indeterminate' | 'abandoned'; uw: Scope; diagnostics: NonEmpty<UwDiagnostic> }
export type DependencyResolution = {
  uw: Scope
  basis: DependencyBasis
  state: 'satisfied' | 'held'
  completion: UwCompletion | null
  diagnostics: readonly UwDiagnostic[]
}
export type UwCompletionAssessment = {
  waits: UwWaitProjection
  dependencies: ReadonlyMap<string, DependencyResolution>
  completions: ReadonlyMap<string, UwCompletion>
  diagnostics: readonly UwDiagnostic[]
}
