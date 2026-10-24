import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic, Scope } from './record-values.ts'

export type AcceptedSpecRef =
  | { kind: 'mandate'; recordId: string; scope: Scope; specDigest: string }
  | { kind: 'editorial'; recordId: string; scope: Scope; acceptedDigest: string; currentDigest: string }
  | { kind: 'accept-material'; recordId: string; scope: Scope; specDigest: string; assessment: ExternalRecordRef }

export type AcceptedSpec = {
  reference: string
  body: string
  digest: string
  lastEditedAt: string
  chain: readonly AcceptedSpecRef[]
  sourceRefs: readonly ExternalRecordRef[]
}

export type AcceptedSpecResult =
  | { ok: true; spec: AcceptedSpec }
  | { ok: false; reason: 'incomplete' | 'ambiguous' | 'material-spec' | 'missing-history'; evidence: Diagnostic[] }
