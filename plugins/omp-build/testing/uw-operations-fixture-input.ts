import type { IssueRef } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import { rawSource, renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwCreateInput, UwProposalInput } from '../roxabi/uw-contract.ts'
import type { IdentityPublicationResult } from '../roxabi/uw-operations.ts'

export const UW: Scope = { repository: 'acme/widgets', target: 'acme/widgets#42' }
export const ISSUE = { repository: UW.repository, number: 42 }
export const CREATED = { repository: UW.repository, number: 99 }
export const CREATED_UW: Scope = { repository: UW.repository, target: `${UW.repository}#${CREATED.number}` }
const FACTORS = { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 }
export const WRITES = {
  labels: { add: [], remove: [] },
  relations: { addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [] },
}

export const SOURCE_BODY = renderIssueSpecBody({
  format: 'omp-build-spec-content/1',
  version: 'a'.repeat(64),
  criteria: [],
  invariants: [],
  exclusions: [],
  openQuestions: [],
  sections: { origin: '', context: '', change: '' },
})

export type MutablePlanWrites = {
  labels: { add: string[]; remove: string[] }
  relations: {
    addChildren: IssueRef[]
    removeChildren: IssueRef[]
    addBlockers: IssueRef[]
    removeBlockers: IssueRef[]
  }
}

export function planWrites(): MutablePlanWrites {
  return {
    labels: { add: ['domain:billing'], remove: [] },
    relations: {
      addChildren: [{ repository: UW.repository, number: 43 }],
      removeChildren: [],
      addBlockers: [],
      removeBlockers: [],
    },
  }
}

export function identityFailure(status: 'refused' | 'partial' | 'uncertain'): IdentityPublicationResult {
  return {
    status,
    diagnostics: [
      {
        code: `identity-${status}`,
        message: `Identity publication ${status}`,
        location: { kind: 'native', uw: UW, connection: 'state' },
        related: [],
      },
    ],
  }
}

export function input(draftKey: string, statement: string, sourceBody = SOURCE_BODY): UwProposalInput {
  return {
    uw: UW,
    sourceBodySha256: rawSource(UW.target, sourceBody, null).bodySha256,
    title: 'Normalize the current UW',
    draft: {
      criteria: [{ kind: 'new', draftKey, statement }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    },
    factors: FACTORS,
    writes: WRITES,
    normalization: [{ kind: 'new', target: { kind: 'new', draftKey }, reason: 'Adds the requested criterion' }],
    tierOverride: null,
  }
}

export function createInput(): UwCreateInput {
  const { uw: _uw, sourceBodySha256: _sourceBodySha256, ...request } = input('unused', 'Unused')
  return {
    ...request,
    repository: UW.repository,
    draft: {
      criteria: [],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    },
  }
}

export function allocationRef(recordId: string): ExternalRecordRef {
  return { scope: UW, recordId, kind: 'spec-identity' }
}
