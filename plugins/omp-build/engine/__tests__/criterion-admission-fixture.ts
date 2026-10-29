import { createHash } from 'node:crypto'
import { pinnedFileRefSchema } from '../action-input-schema.ts'
import { evidenceDigest } from '../criterion-admission.ts'
import {
  type CodeVersion,
  type CommandRun,
  CRITERION_EVIDENCE_FORMAT,
  type CriterionEvidence,
  commandRunSchema,
  criterionDeclarationSchema,
  criterionEvidenceSchema,
  type EvidenceRef,
  evidenceRefSchema,
  type TestExecution,
  testExecutionSchema,
} from '../criterion-evidence-schema.ts'
import {
  type CriterionVerdict,
  criterionVerdictSchema,
  type ExclusionClaim,
  exclusionClaimSchema,
} from '../criterion-verdict-schema.ts'
import {
  type CriterionTarget,
  criterionTargetSchema,
  FINDING_TARGET_FORMAT,
  findingTargetSchema,
} from '../finding-target-schema.ts'
import { type ExternalRecordRef, externalRecordRefSchema } from '../record-references.ts'
import { type SpecEffective, specEffectiveSchema } from '../spec-effective.ts'
import type { OwnSpecRef } from '../uw-spec-schema.ts'
import { type PlanOutput, planOutputSchema } from '../workflow-output-schema.ts'

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

export const scope = { repository: 'acme/app', target: 'acme/app#42' }
export const otherScope = { repository: 'other/app', target: 'other/app#7' }
const sourceAccepted = { scope, recordId: 'mandate-region', kind: 'mandate' as const }
const version = sha('accepted spec: reload keeps the selected region')
export const own: OwnSpecRef = { uw: scope, version, sourceAccepted }
export const foreignOwn: OwnSpecRef = {
  uw: scope,
  version: sha('previous accepted spec before region persistence'),
  sourceAccepted: { scope, recordId: 'mandate-previous', kind: 'mandate' },
}
export const candidate: CodeVersion = {
  repository: 'acme/app',
  commit: sha('candidate tree: region save').slice(0, 40),
}
export const earlier: CodeVersion = { repository: 'acme/app', commit: sha('parent tree: region dropped').slice(0, 40) }

export function acceptedSpec(criteria: readonly { id: 'C1' | 'C2'; statement: string }[]): SpecEffective {
  return specEffectiveSchema.parse({
    format: 'omp-build-spec-effective/1',
    resolution: 'own-only',
    own,
    versionVector: [own],
    ancestry: 'not-resolved',
    spec: {
      format: 'omp-build-spec-content/1',
      version,
      criteria,
      invariants: [{ id: 'I1', statement: 'save does not drop unrelated fields' }],
      exclusions: ['does not cover bulk export'],
      openQuestions: [],
      sections: { origin: 'Issue 904', context: 'Region save', change: 'Persist the selected region' },
    },
  })
}

export const paired = acceptedSpec([
  { id: 'C2', statement: 'export remains unavailable' },
  { id: 'C1', statement: 'reload keeps the selected region' },
])
export const solo = acceptedSpec([{ id: 'C1', statement: 'reload keeps the selected region' }])

export function criterionTarget(id: 'C1' | 'C2', spec: OwnSpecRef = own) {
  return criterionTargetSchema.parse({ format: FINDING_TARGET_FORMAT, kind: 'criterion', spec, id })
}
export function invariantTarget(spec: OwnSpecRef = own) {
  return findingTargetSchema.parse({ format: FINDING_TARGET_FORMAT, kind: 'invariant', spec, id: 'I1' })
}

export function receipt(
  recordScope: typeof scope = scope,
  kind: ExternalRecordRef['kind'] = 'action-receipt',
  recordId = 'implement-region',
): ExternalRecordRef {
  return externalRecordRefSchema.parse({ scope: recordScope, recordId, kind })
}

export function observedRun(exitCode: number, text: string, toolCallId: string): CommandRun {
  return commandRunSchema.parse({
    toolCallId,
    command: 'bun test src/region.test.ts',
    exitCode,
    output: { kind: 'combined', text },
    context: { probeCwd: 'plugins/omp-build', start: null, end: null },
  })
}

export function claimedRun(code: CodeVersion, exitCode: number, text: string, toolCallId: string): TestExecution {
  return testExecutionSchema.parse({
    run: observedRun(exitCode, text, toolCallId),
    versionClaim: { code, reason: 'cited captured run', references: [] },
  })
}

function provenance(toolCallIds: string[]) {
  return {
    kind: 'native' as const,
    actionId: 'implement-region',
    childId: 'child-region',
    submissionIndex: 0,
    toolCallIds,
  }
}

function pin(path: string, bytes: string) {
  return pinnedFileRefSchema.parse({
    source: 'git-file',
    repository: candidate.repository,
    commit: candidate.commit,
    path,
    digest: sha(bytes),
  })
}

type TestPatch = Partial<{
  id: string
  target: CriterionTarget
  code: CodeVersion
  scenario: string
  before: TestExecution | null
  after: TestExecution
}>

export function passingTest(id: 'C1' | 'C2', patch: TestPatch = {}): CriterionEvidence {
  const passed = id === 'C1' ? 'PASS selected region survived reload' : 'PASS export stayed unavailable'
  return criterionEvidenceSchema.parse({
    format: CRITERION_EVIDENCE_FORMAT,
    id: id === 'C1' ? 'evidence-reload' : 'evidence-export',
    target: criterionTarget(id),
    code: candidate,
    provenance: provenance(['tool-region-after']),
    method: 'test',
    scenario: id === 'C1' ? 'reload keeps the selected region' : 'export remains unavailable',
    before: null,
    after: claimedRun(candidate, 0, passed, 'tool-region-after'),
    ...patch,
  })
}

export function restoredByTest(beforeExit: number, beforeText: string): CriterionEvidence {
  return criterionEvidenceSchema.parse({
    format: CRITERION_EVIDENCE_FORMAT,
    id: 'evidence-reload',
    target: criterionTarget('C1'),
    code: candidate,
    provenance: provenance(['tool-region-before', 'tool-region-after']),
    method: 'test',
    scenario: 'reload keeps the selected region',
    before: claimedRun(earlier, beforeExit, beforeText, 'tool-region-before'),
    after: claimedRun(candidate, 0, 'PASS selected region survived reload', 'tool-region-after'),
  })
}

export function contentReading(): CriterionEvidence {
  const finding = 'docs/region.md states that reload keeps the selected region'
  return criterionEvidenceSchema.parse({
    format: CRITERION_EVIDENCE_FORMAT,
    id: 'evidence-reading',
    target: criterionTarget('C1'),
    code: candidate,
    provenance: provenance(['tool-read-region']),
    method: 'content-reading',
    references: [pin('docs/region.md', finding)],
    finding,
  })
}

export function restoredObservation(): CriterionEvidence {
  const observedResult = 'selected region was present after reload in the running prompt'
  return criterionEvidenceSchema.parse({
    format: CRITERION_EVIDENCE_FORMAT,
    id: 'evidence-restored',
    target: criterionTarget('C1'),
    code: candidate,
    provenance: provenance(['tool-prompt-region']),
    method: 'prompt-observation',
    scenario: 'reload keeps the selected region',
    observedResult,
    references: [pin('notes/region-restored.txt', observedResult)],
  })
}

export function evidenceRef(value: CriterionEvidence, record: ExternalRecordRef = receipt()): EvidenceRef {
  return evidenceRefSchema.parse({ receipt: record, evidenceId: value.id, digest: evidenceDigest(value) })
}

export function evidenceDeclaration(value: CriterionEvidence) {
  return criterionDeclarationSchema.parse({ target: value.target, verification: 'evidence', evidence: [value] })
}

export function unverifiedDeclaration(id: 'C1' | 'C2', reason: string) {
  return criterionDeclarationSchema.parse({ target: criterionTarget(id), verification: 'unverified', reason })
}

export function satisfied(
  value: CriterionEvidence,
  patch: Partial<
    Pick<CriterionVerdict, 'criterionKind' | 'bugRegression' | 'restoration' | 'examined' | 'target' | 'reason'>
  > = {},
) {
  return criterionVerdictSchema.parse({
    target: value.target,
    verdict: 'satisfied',
    criterionKind: 'behavior',
    bugRegression: false,
    restoration: 'not-applicable',
    examined: [
      {
        evidence: evidenceRef(value),
        truth: 'supported',
        applicability: 'applies',
        codeLink:
          value.method === 'test'
            ? {
                method: 'test',
                after: { support: 'supported', reason: 'captured command exercised the candidate', references: [] },
                before:
                  value.before === null
                    ? null
                    : {
                        support: 'supported',
                        reason: 'captured command exercised the earlier version',
                        references: [],
                      },
              }
            : {
                method: 'observation',
                current: { support: 'supported', reason: 'observation concerns the candidate', references: [] },
              },
        reason: 'observed result matches the criterion scenario',
      },
    ],
    reason: 'declared evidence supports the criterion',
    ...patch,
  })
}

export function plan(steps: PlanOutput['steps']): PlanOutput {
  return planOutputSchema.parse({ steps, resolutions: [] })
}

export function exclusion(patch: Partial<Pick<ExclusionClaim, 'target' | 'concern' | 'exclusion'>> = {}) {
  return exclusionClaimSchema.parse({
    sourceFindingId: 'finding-bulk-export',
    target: { format: FINDING_TARGET_FORMAT, kind: 'outside-spec', uw: scope, element: 'bulk export button' },
    exclusion: { spec: own, index: 0 },
    concern: 'additional-work',
    reason: 'bulk export is the cited exclusion, not an accepted criterion',
    ...patch,
  })
}

export function outsideTarget(uw: typeof scope) {
  return findingTargetSchema.parse({
    format: FINDING_TARGET_FORMAT,
    kind: 'outside-spec',
    uw,
    element: 'bulk export button',
  })
}

export function unproven(id: 'C1' | 'C2', reason: string) {
  return criterionVerdictSchema.parse({
    target: criterionTarget(id),
    verdict: 'satisfied',
    criterionKind: 'behavior',
    bugRegression: false,
    restoration: 'not-applicable',
    examined: [],
    reason,
  })
}
