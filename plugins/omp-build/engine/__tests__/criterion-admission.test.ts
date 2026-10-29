import { describe, expect, test } from 'vitest'
import {
  assessCriterionDeclarations,
  assessCriterionReview,
  assessExclusion,
  assessPlanCoverage,
  evidenceDigest,
} from '../criterion-admission.ts'
import { type CriterionEvidence, type EvidenceRef, evidenceRefSchema } from '../criterion-evidence-schema.ts'
import type { CriterionVerdict } from '../criterion-verdict-schema.ts'
import type { SpecEffective } from '../spec-effective.ts'
import {
  candidate,
  claimedRun,
  contentReading,
  criterionTarget,
  earlier,
  evidenceDeclaration,
  evidenceRef,
  exclusion,
  foreignOwn,
  invariantTarget,
  otherScope,
  outsideTarget,
  own,
  paired,
  passingTest,
  plan,
  receipt,
  restoredByTest,
  restoredObservation,
  satisfied,
  solo,
  unproven,
  unverifiedDeclaration,
} from './criterion-admission-fixture.ts'

function review(spec: SpecEffective, value: CriterionEvidence, verdict: CriterionVerdict = satisfied(value)) {
  const ref = evidenceRef(value)
  return assessCriterionReview({
    spec,
    code: candidate,
    declarations: [evidenceDeclaration(value)],
    verdicts: [verdict],
    evidence: [{ ref, value }],
  })
}

function approves(spec: SpecEffective, value: CriterionEvidence, verdict?: CriterionVerdict): boolean {
  const assessment = review(spec, value, verdict)
  return assessment.complete && !assessment.requiresChanges
}

function cite(
  declared: CriterionEvidence,
  cited: EvidenceRef,
  supplied: EvidenceRef,
  suppliedValue: CriterionEvidence,
) {
  const row = satisfied(declared).examined[0]
  const assessment = assessCriterionReview({
    spec: solo,
    code: candidate,
    declarations: [evidenceDeclaration(declared)],
    verdicts: [satisfied(declared, { examined: [{ ...row, evidence: cited }] })],
    evidence: [{ ref: supplied, value: suppliedValue }],
  })
  return assessment.complete && !assessment.requiresChanges
}

function withSupport(
  value: CriterionEvidence,
  slot: 'after' | 'before' | 'current',
  support: 'unknown' | 'unsupported',
  patch: Parameters<typeof satisfied>[1] = {},
): CriterionVerdict {
  const row = satisfied(value, patch).examined[0]
  if (row.codeLink.method === 'test') {
    if (slot === 'after') {
      return satisfied(value, {
        ...patch,
        examined: [
          {
            ...row,
            codeLink: { method: 'test', after: { ...row.codeLink.after, support }, before: row.codeLink.before },
          },
        ],
      })
    }
    if (slot === 'before') {
      if (row.codeLink.before === null) throw new Error('test evidence has no before version link')
      return satisfied(value, {
        ...patch,
        examined: [
          {
            ...row,
            codeLink: { method: 'test', after: row.codeLink.after, before: { ...row.codeLink.before, support } },
          },
        ],
      })
    }
    throw new Error('test evidence has no current version link')
  }
  if (slot !== 'current') throw new Error('observation evidence has no run version link')
  return satisfied(value, {
    ...patch,
    examined: [{ ...row, codeLink: { method: 'observation', current: { ...row.codeLink.current, support } } }],
  })
}

function withoutBeforeLink(value: CriterionEvidence, patch: Parameters<typeof satisfied>[1] = {}): CriterionVerdict {
  const row = satisfied(value, patch).examined[0]
  if (row.codeLink.method !== 'test') throw new Error('not a test row')
  return satisfied(value, {
    ...patch,
    examined: [{ ...row, codeLink: { method: 'test', after: row.codeLink.after, before: null } }],
  })
}

function withoutMatchingLink(value: CriterionEvidence, patch: Parameters<typeof satisfied>[1] = {}): CriterionVerdict {
  const row = satisfied(value, patch).examined[0]
  if (row.codeLink.method === 'test') {
    return satisfied(value, {
      ...patch,
      examined: [{ ...row, codeLink: { method: 'observation', current: row.codeLink.after } }],
    })
  }
  const testRow = satisfied(passingTest('C1')).examined[0]
  if (testRow.codeLink.method !== 'test') throw new Error('expected test row')
  return satisfied(value, {
    ...patch,
    examined: [{ ...row, codeLink: { method: 'test', after: testRow.codeLink.after, before: null } }],
  })
}

describe('criterion admission', () => {
  test('names sorted unknown and orphan criteria and admits many-to-many coverage', () => {
    const incomplete = plan([
      {
        id: 'step-export',
        change: 'add bulk export',
        doneWhen: 'an export file exists',
        criterionIds: ['C9', 'C3'],
        evidence: 'export file snapshot',
        paths: ['src/export.ts'],
      },
    ])
    expect(assessPlanCoverage({ spec: paired, plan: incomplete })).toMatchObject({
      ok: false,
      diagnostics: [
        { code: 'plan-coverage', detail: { unknownCriterionIds: ['C3', 'C9'], orphanCriterionIds: ['C1', 'C2'] } },
      ],
    })

    const covered = plan([
      {
        id: 'step-save',
        change: 'persist the selected region',
        doneWhen: 'reload keeps the selected region and export stays unavailable',
        criterionIds: ['C1', 'C2'],
        evidence: 'save and reload test',
        paths: ['src/region.ts'],
      },
      {
        id: 'step-reload',
        change: 'cover reload again from the read path',
        doneWhen: 'reload still keeps the selected region',
        criterionIds: ['C1'],
        evidence: 'second reload test',
        paths: ['src/reload.ts'],
      },
    ])
    expect(assessPlanCoverage({ spec: paired, plan: covered })).toEqual({ ok: true, value: covered })
  })

  test('rejects a repeated evidence id across accepted criteria', () => {
    const reload = passingTest('C1')
    const exported = passingTest('C2', { id: reload.id })
    expect(
      assessCriterionDeclarations({
        spec: paired,
        code: candidate,
        declarations: [evidenceDeclaration(reload), evidenceDeclaration(exported)],
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'duplicate-reference', message: expect.stringContaining(reload.id) }],
    })
  })

  test('does not approve a missing or unverified declaration when the model produced no findings', () => {
    const reload = passingTest('C1')
    const ref = evidenceRef(reload)
    const missing = assessCriterionReview({
      spec: paired,
      code: candidate,
      declarations: [evidenceDeclaration(reload)],
      verdicts: [satisfied(reload)],
      evidence: [{ ref, value: reload }],
    })
    expect(missing.complete).toBe(false)
    expect(missing.requiresChanges).toBe(true)
    expect(missing.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing-declaration', detail: { orphanCriterionIds: ['C2'] } }),
        expect.objectContaining({ code: 'criterion-changes', detail: { orphanCriterionIds: ['C2'] } }),
      ]),
    )

    const unverified = assessCriterionReview({
      spec: paired,
      code: candidate,
      declarations: [
        evidenceDeclaration(reload),
        unverifiedDeclaration('C2', 'host spill for the export command was not retained'),
      ],
      verdicts: [satisfied(reload), unproven('C2', 'model marked export satisfied without retained output')],
      evidence: [{ ref, value: reload }],
    })
    expect(unverified).toMatchObject({ complete: true, requiresChanges: true })
  })

  test('resolves only the authentic receipt scope, kind, record, evidence id, and digest', () => {
    const proof = passingTest('C1')
    const authentic = evidenceRef(proof)
    const tampered = passingTest('C1', { scenario: 'reload drops the selected region' })
    const wrongUw = evidenceRef(proof, receipt(otherScope, 'action-receipt', authentic.receipt.recordId))
    expect(review(solo, proof)).toEqual({ complete: true, requiresChanges: false, diagnostics: [] })
    const collisions = [
      wrongUw,
      evidenceRef(proof, receipt(authentic.receipt.scope, 'contribution', authentic.receipt.recordId)),
      evidenceRef(proof, receipt(authentic.receipt.scope, 'action-receipt', 'implement-other')),
      evidenceRefSchema.parse({ ...authentic, evidenceId: 'evidence-unrelated' }),
      evidenceRefSchema.parse({ ...authentic, digest: evidenceDigest(tampered) }),
    ]
    for (const cited of collisions) expect(cite(proof, cited, authentic, proof)).toBe(false)
    expect(cite(proof, authentic, wrongUw, proof)).toBe(false)
    expect(cite(proof, authentic, authentic, tampered)).toBe(false)
  })

  test('does not accept proof bound to another candidate or spec version', () => {
    const passed = 'PASS selected region survived reload'
    const onEarlier = passingTest('C1', { code: earlier })
    const afterElsewhere = passingTest('C1', { after: claimedRun(earlier, 0, passed, 'tool-region-after') })
    expect(approves(solo, passingTest('C1'))).toBe(true)
    expect(approves(solo, onEarlier)).toBe(false)
    expect(approves(solo, afterElsewhere)).toBe(false)
    expect(approves(solo, passingTest('C1', { target: criterionTarget('C1', foreignOwn) }))).toBe(false)
  })

  test('does not let source reading prove a behavior criterion', () => {
    const reading = contentReading()
    expect(approves(solo, reading)).toBe(false)
    expect(review(solo, reading, satisfied(reading, { criterionKind: 'content' }))).toEqual({
      complete: true,
      requiresChanges: false,
      diagnostics: [],
    })
  })

  test('does not let pinned content reading satisfy a bug regression without demonstrated restoration', () => {
    const reading = contentReading()
    const assessment = review(
      solo,
      reading,
      satisfied(reading, { criterionKind: 'content', bugRegression: true, restoration: 'not-demonstrated' }),
    )
    expect(assessment.requiresChanges).toBe(true)
    expect(assessment.complete && !assessment.requiresChanges).toBe(false)
  })

  test('requires an observed failure before a passing bug fix, or a demonstrated restoration', () => {
    const generic = passingTest('C1')
    const failed = passingTest('C1', {
      after: claimedRun(candidate, 1, 'FAIL selected region missing after reload', 'tool-region-after'),
    })
    const alreadyGreen = restoredByTest(0, 'PASS selected region survived reload')
    const restored = restoredByTest(1, 'FAIL selected region missing after reload')
    const observed = restoredObservation()
    expect(approves(solo, generic, satisfied(generic, { bugRegression: true }))).toBe(false)
    expect(approves(solo, failed)).toBe(false)
    expect(approves(solo, alreadyGreen, satisfied(alreadyGreen, { bugRegression: true }))).toBe(false)
    expect(review(solo, restored, satisfied(restored, { bugRegression: true }))).toEqual({
      complete: true,
      requiresChanges: false,
      diagnostics: [],
    })
    expect(review(solo, observed, satisfied(observed, { bugRegression: true, restoration: 'demonstrated' }))).toEqual({
      complete: true,
      requiresChanges: false,
      diagnostics: [],
    })
    expect(
      approves(solo, observed, satisfied(observed, { bugRegression: true, restoration: 'not-demonstrated' })),
    ).toBe(false)
  })

  test('does not approve an unknown, unsupported, or missing actual version link', () => {
    const passed = passingTest('C1')
    const restored = restoredByTest(1, 'FAIL selected region missing after reload')
    const reading = contentReading()
    const observed = restoredObservation()
    const regression = { bugRegression: true }
    const content = { criterionKind: 'content' as const }
    const demonstrated = { bugRegression: true, restoration: 'demonstrated' as const }

    expect(approves(solo, passed)).toBe(true)
    expect(approves(solo, passed, withSupport(passed, 'after', 'unknown'))).toBe(false)
    expect(approves(solo, passed, withSupport(passed, 'after', 'unsupported'))).toBe(false)
    expect(approves(solo, passed, withoutMatchingLink(passed))).toBe(false)

    expect(approves(solo, restored, satisfied(restored, regression))).toBe(true)
    expect(approves(solo, restored, withSupport(restored, 'after', 'unknown', regression))).toBe(false)
    expect(approves(solo, restored, withSupport(restored, 'before', 'unknown', regression))).toBe(false)
    expect(approves(solo, restored, withSupport(restored, 'before', 'unsupported', regression))).toBe(false)
    expect(approves(solo, restored, withoutBeforeLink(restored, regression))).toBe(false)

    expect(approves(solo, reading, satisfied(reading, content))).toBe(true)
    expect(approves(solo, reading, withSupport(reading, 'current', 'unknown', content))).toBe(false)
    expect(approves(solo, reading, withSupport(reading, 'current', 'unsupported', content))).toBe(false)
    expect(approves(solo, reading, withoutMatchingLink(reading, content))).toBe(false)

    expect(approves(solo, observed, satisfied(observed, demonstrated))).toBe(true)
    expect(approves(solo, observed, withSupport(observed, 'current', 'unknown', demonstrated))).toBe(false)
    expect(approves(solo, observed, withSupport(observed, 'current', 'unsupported', demonstrated))).toBe(false)
    expect(approves(solo, observed, withoutMatchingLink(observed, demonstrated))).toBe(false)
  })

  test('admits excluded additional work and refuses criterion, security, regression, and invariant waivers', () => {
    const admitted = exclusion()
    expect(assessExclusion({ spec: paired, claim: admitted })).toEqual({ ok: true, value: admitted })
    const refused = [
      exclusion({ target: criterionTarget('C1'), concern: 'additional-work' }),
      exclusion({ target: invariantTarget(), concern: 'additional-work' }),
      exclusion({ concern: 'security' }),
      exclusion({ concern: 'introduced-regression' }),
      exclusion({ concern: 'invariant-violation' }),
      exclusion({ concern: 'unknown' }),
      exclusion({ exclusion: { spec: own, index: 1 } }),
      exclusion({ exclusion: { spec: foreignOwn, index: 0 } }),
      exclusion({ target: outsideTarget(otherScope) }),
    ]
    for (const claim of refused) expect(assessExclusion({ spec: paired, claim }).ok).toBe(false)
  })
})
