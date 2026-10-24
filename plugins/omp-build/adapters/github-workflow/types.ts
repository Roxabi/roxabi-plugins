import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Diagnostic, Json, Scope } from '../../engine/record-values.ts'

export type LinkedIssueAssociation =
  | { status: 'linked'; scope: Scope; number: number }
  | { status: 'none' }
  | { status: 'ambiguous' | 'incomplete' | 'unreadable'; diagnostics: Diagnostic[] }

export type NativePullRequestFacts = {
  repository: string
  pr: number
  head: string
  base: string
  baseTip: string
  branch: string
  state: string
  author: string | null
}

export type NativeIssueFacts = {
  repository: string
  number: number
  state: string
  author: string | null
  body: string
  isPullRequest: boolean
}

export type NativeTargetResolution =
  | { status: 'issue'; scope: Scope; issue: NativeIssueFacts }
  | { status: 'pull-request'; scope: Scope; pullRequest: NativePullRequestFacts }
  | { status: 'ambiguous' | 'incomplete' | 'unreadable' | 'refused'; diagnostics: Diagnostic[] }

export type IssueParentAssociation =
  | { status: 'linked'; scope: Scope; number: number }
  | { status: 'none' }
  | { status: 'ambiguous' | 'incomplete' | 'unreadable'; diagnostics: Diagnostic[] }

export type ComposedWorkflowHistory =
  | { ok: true; scopes: Scope[]; histories: DecodedHistory[]; records: CanonicalRecord[] }
  | {
      ok: false
      reason: 'incomplete' | 'ambiguous' | 'unreadable'
      diagnostics: Diagnostic[]
      histories: DecodedHistory[]
      evidence?: Json
    }

export type LandingFactsRead =
  | {
      ok: true
      /** Authenticated records are derived from these histories only. */
      histories: DecodedHistory[]
      /** Exact requireLandingMandate.native; GH numbers stay adapter-private. */
      native: { branch: string; base: string; pullRequest: Scope; linkedIssueScopes: Scope[] }
      /** Observed PR tips for product gates; never copied into engine native. */
      observed: { head: string; baseTip: string }
      /** Exact live issue bodies for the bound mandate scope. */
      linkedIssueBodies: { scope: Scope; body: string }[]
      /** Explicit mandate.parent scopes. Empty means no delivery parent; missing is not empty. */
      parentScopes: Scope[]
      /** Applicable PR workflow-binding. Predecessor records may remain in histories. */
      binding: CanonicalRecord
    }
  | {
      ok: false
      reason: 'absent' | 'partial' | 'conflicting' | 'unconfirmed' | 'incomplete' | 'ambiguous' | 'unreadable'
      diagnostics: Diagnostic[]
      evidence?: Json
    }

export type WorkflowPublication =
  | { status: 'confirmed'; operation: DecodedHistory['operations'][number] }
  | { status: 'uncertain' | 'refused'; history: DecodedHistory; diagnostics: Diagnostic[] }

export type WorkflowBindingRead =
  | {
      ok: true
      value: {
        binding: CanonicalRecord
        history: DecodedHistory
        histories: DecodedHistory[]
        linkedIssueBodies: { scope: Scope; body: string }[]
        parentScopes: Scope[]
        native: Extract<LandingFactsRead, { ok: true }>['native']
        observed: { head: string; baseTip: string }
      }
    }
  | {
      ok: false
      status: 'absent' | 'partial' | 'conflicting' | 'unconfirmed' | 'incomplete' | 'unreadable'
      reason: 'absent' | 'partial' | 'conflicting' | 'unconfirmed' | 'incomplete' | 'unreadable'
      diagnostics: Diagnostic[]
      evidence?: Json
    }

export const RECORD_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
export const SHA = /^[0-9a-f]{40}$/
export const POSITIVE_INT = /^[1-9][0-9]*$/

export function diagnostic(code: string, message: string, detail?: Json): Diagnostic {
  return detail === undefined ? { code, message } : { code, message, detail }
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
