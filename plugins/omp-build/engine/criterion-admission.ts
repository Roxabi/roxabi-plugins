import { createHash } from 'node:crypto'
import { projectAdditiveDeclarations } from './criterion-declaration-projection.ts'
import type { CodeVersion, CriterionDeclaration, CriterionEvidence, EvidenceRef } from './criterion-evidence-schema.ts'
import type { CriterionVerdict, ExclusionClaim } from './criterion-verdict-schema.ts'
import type { CriterionTarget } from './finding-target-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import type { SpecEffective } from './spec-effective.ts'
import { sameOwnSpecRef } from './spec-effective.ts'
import type { PlanOutput } from './workflow-output-schema.ts'

export type CriterionReviewInput = {
  spec: SpecEffective
  code: CodeVersion
  declarations: readonly CriterionDeclaration[]
  verdicts: readonly CriterionVerdict[]
  evidence: readonly { ref: EvidenceRef; value: CriterionEvidence }[]
}
export type CriterionReviewAssessment = {
  complete: boolean
  requiresChanges: boolean
  diagnostics: Diagnostic[]
}

function named(code: string, message: string, detail?: Diagnostic['detail']): Diagnostic {
  return detail === undefined ? { code, message } : { code, message, detail }
}

function sameTarget(left: CriterionTarget, right: CriterionTarget): boolean {
  return left.id === right.id && sameOwnSpecRef(left.spec, right.spec)
}

function sameCode(left: CodeVersion, right: CodeVersion): boolean {
  return left.repository === right.repository && left.commit === right.commit
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) sorted[key] = ordered(source[key])
    return sorted
  }
  return value
}

export function evidenceDigest(value: CriterionEvidence): string {
  return createHash('sha256')
    .update(JSON.stringify(ordered(value)), 'utf8')
    .digest('hex')
}

function owns(spec: SpecEffective, target: CriterionTarget): boolean {
  return sameOwnSpecRef(target.spec, spec.own) && spec.spec.criteria.some((item) => item.id === target.id)
}

export function assessPlanCoverage({ spec, plan }: { spec: SpecEffective; plan: PlanOutput }): Result<PlanOutput> {
  const known = new Set(spec.spec.criteria.map((item) => item.id))
  const covered = new Set(plan.steps.flatMap((step) => step.criterionIds))
  const unknownCriterionIds = [...covered].filter((id) => !known.has(id)).sort()
  const orphanCriterionIds = [...known].filter((id) => !covered.has(id)).sort()
  if (unknownCriterionIds.length === 0 && orphanCriterionIds.length === 0) return { ok: true, value: plan }
  return {
    ok: false,
    diagnostics: [
      named('plan-coverage', 'plan criterion coverage is incomplete', { unknownCriterionIds, orphanCriterionIds }),
    ],
  }
}

function recordEvidence(
  evidence: CriterionEvidence,
  declaration: CriterionDeclaration,
  code: CodeVersion,
  evidenceIds: Set<string>,
  diagnostics: Diagnostic[],
): void {
  if (evidenceIds.has(evidence.id))
    diagnostics.push(named('duplicate-reference', `Evidence ${evidence.id} is repeated`))
  evidenceIds.add(evidence.id)
  if (!sameTarget(evidence.target, declaration.target) || !sameCode(evidence.code, code)) {
    diagnostics.push(named('mismatch', `Evidence ${evidence.id} does not bind the admitted criterion and code`))
  }
  if (evidence.method === 'test' && !sameCode(evidence.after.versionClaim.code, code)) {
    diagnostics.push(named('mismatch', `Evidence ${evidence.id} after claim is not the admitted candidate`))
  }
}

function recordDeclaration(
  declaration: CriterionDeclaration,
  spec: SpecEffective,
  code: CodeVersion,
  seen: Set<string>,
  evidenceIds: Set<string>,
  diagnostics: Diagnostic[],
): void {
  if (!owns(spec, declaration.target)) {
    diagnostics.push(named('malformed', `Declaration ${declaration.target.id} is not an accepted criterion`))
  }
  if (seen.has(declaration.target.id)) {
    diagnostics.push(named('duplicate-reference', `Criterion ${declaration.target.id} is declared more than once`))
  }
  seen.add(declaration.target.id)
  if (declaration.verification !== 'evidence') return
  for (const evidence of declaration.evidence) recordEvidence(evidence, declaration, code, evidenceIds, diagnostics)
}

function orphanCriterionIds(spec: SpecEffective, seen: ReadonlySet<string>): string[] {
  return spec.spec.criteria
    .map((item) => item.id)
    .filter((id) => !seen.has(id))
    .sort()
}

export function assessCriterionDeclarations({
  spec,
  code,
  declarations,
}: {
  spec: SpecEffective
  code: CodeVersion
  declarations: readonly CriterionDeclaration[]
}): Result<readonly CriterionDeclaration[]> {
  const projected = projectAdditiveDeclarations(declarations)
  const diagnostics: Diagnostic[] = []
  const seen = new Set<string>()
  const evidenceIds = new Set<string>()
  for (const declaration of projected) recordDeclaration(declaration, spec, code, seen, evidenceIds, diagnostics)
  const missing = orphanCriterionIds(spec, seen)
  if (missing.length > 0)
    diagnostics.push(
      named('missing-declaration', 'accepted criteria lack a declaration', { orphanCriterionIds: missing }),
    )
  return diagnostics.length === 0 ? { ok: true, value: projected } : { ok: false, diagnostics }
}

function testMethodAdmits(
  verdict: CriterionVerdict,
  value: Extract<CriterionEvidence, { method: 'test' }>,
  code: CodeVersion,
  judgment: CriterionVerdict['examined'][number],
): boolean {
  if (judgment.codeLink.method !== 'test') return false
  if ((judgment.codeLink.before === null) !== (value.before === null)) return false
  if (judgment.codeLink.after.support !== 'supported') return false
  if (value.before !== null && judgment.codeLink.before?.support !== 'supported') return false
  if (value.after.run.exitCode !== 0 || !sameCode(value.after.versionClaim.code, code)) return false
  if (!verdict.bugRegression) return true
  return value.before !== null && value.before.run.exitCode !== 0
}

function observationMethodAdmits(
  verdict: CriterionVerdict,
  value: CriterionEvidence,
  judgment: CriterionVerdict['examined'][number],
): boolean {
  if (judgment.codeLink.method !== 'observation' || judgment.codeLink.current.support !== 'supported') return false
  if (value.method === 'content-reading') return verdict.criterionKind === 'content' && !verdict.bugRegression
  return verdict.bugRegression ? verdict.restoration === 'demonstrated' : true
}

function methodAdmits(
  verdict: CriterionVerdict,
  value: CriterionEvidence,
  code: CodeVersion,
  judgment: CriterionVerdict['examined'][number],
): boolean {
  if (!sameTarget(value.target, verdict.target) || !sameCode(value.code, code)) return false
  if (value.method === 'test') return testMethodAdmits(verdict, value, code, judgment)
  return observationMethodAdmits(verdict, value, judgment)
}
function resolved(
  input: CriterionReviewInput,
  ref: CriterionReviewInput['evidence'][number]['ref'],
): CriterionEvidence | null {
  const match = input.evidence.find(
    (item) =>
      sameRef(item.ref.receipt, ref.receipt) &&
      item.ref.evidenceId === ref.evidenceId &&
      item.ref.digest === ref.digest &&
      evidenceDigest(item.value) === ref.digest,
  )
  return match?.value ?? null
}

function declared(input: CriterionReviewInput, value: CriterionEvidence): boolean {
  return input.declarations.some(
    (declaration) =>
      declaration.verification === 'evidence' &&
      declaration.evidence.some(
        (evidence) => evidence.id === value.id && evidenceDigest(evidence) === evidenceDigest(value),
      ),
  )
}

function verdictChanges(input: CriterionReviewInput, verdict: CriterionVerdict, diagnostics: Diagnostic[]): boolean {
  if (!owns(input.spec, verdict.target)) {
    diagnostics.push(named('malformed', `Verdict ${verdict.target.id} is not an accepted criterion`))
    return true
  }
  if (verdict.verdict !== 'satisfied') return true
  let admitted = false
  for (const judgment of verdict.examined) {
    const value = resolved(input, judgment.evidence)
    if (value === null || !declared(input, value)) {
      diagnostics.push(named('malformed', `Verdict ${verdict.target.id} cites an unresolved evidence ref`))
      continue
    }
    if (judgment.truth !== 'supported' || judgment.applicability !== 'applies') continue
    if (methodAdmits(verdict, value, input.code, judgment)) admitted = true
  }
  return !admitted
}

export function assessCriterionReview(input: CriterionReviewInput): CriterionReviewAssessment {
  const diagnostics: Diagnostic[] = []
  const structural = assessCriterionDeclarations(input)
  if (!structural.ok) diagnostics.push(...structural.diagnostics)
  const seen = new Set<string>()
  let requiresChanges = !structural.ok
  for (const verdict of input.verdicts) {
    if (seen.has(verdict.target.id)) {
      diagnostics.push(named('malformed', `Criterion ${verdict.target.id} has more than one verdict`))
    }
    seen.add(verdict.target.id)
    if (verdictChanges(input, verdict, diagnostics)) requiresChanges = true
  }
  const orphanCriterionIds = input.spec.spec.criteria
    .map((item) => item.id)
    .filter((id) => !seen.has(id))
    .sort()
  if (orphanCriterionIds.length > 0) {
    requiresChanges = true
    diagnostics.push(named('criterion-changes', 'accepted criteria lack a verdict', { orphanCriterionIds }))
  }
  const malformed = diagnostics.some(
    (item) =>
      item.code === 'malformed' ||
      item.code === 'duplicate-reference' ||
      item.code === 'missing-declaration' ||
      item.code === 'mismatch',
  )
  return { complete: orphanCriterionIds.length === 0 && structural.ok && !malformed, requiresChanges, diagnostics }
}

export function assessExclusion({
  spec,
  claim,
}: {
  spec: SpecEffective
  claim: ExclusionClaim
}): Result<ExclusionClaim> {
  if (claim.target.kind !== 'outside-spec' || claim.concern !== 'additional-work') {
    return {
      ok: false,
      diagnostics: [named('malformed', 'exclusion cannot waive a criterion, regression, security, or invariant')],
    }
  }
  if (!sameOwnSpecRef(claim.exclusion.spec, spec.own) || claim.target.uw.repository !== spec.own.uw.repository) {
    return { ok: false, diagnostics: [named('malformed', 'exclusion version is not the readable own Spec')] }
  }
  if (claim.target.uw.target !== spec.own.uw.target) {
    return { ok: false, diagnostics: [named('malformed', 'exclusion target is outside the accepted UW')] }
  }
  if (
    !Number.isInteger(claim.exclusion.index) ||
    claim.exclusion.index < 0 ||
    claim.exclusion.index >= spec.spec.exclusions.length
  ) {
    return { ok: false, diagnostics: [named('malformed', 'exclusion index is not in the cited Spec version')] }
  }
  return { ok: true, value: claim }
}
