import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { observeHistoricalPins } from '../../adapters/github/historical-pins.ts'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { decision } from '../../testing/record-decisions.ts'
import { actionInputDigest } from '../action-input.ts'
import type { ActionInputs, PinnedFileRef } from '../action-input-schema.ts'
import { criterionAssessmentForDecision } from '../criterion-decision.ts'
import { observationRefDiagnostics } from '../delivery-observation-authentication.ts'
import { constraintExaminationProblem } from '../workflow-compatibility-citations.ts'
import { specAssessmentSchema } from '../workflow-output-schema.ts'
import {
  claimedRun,
  criterionTarget,
  evidenceDeclaration,
  passingTest,
  satisfied,
} from './criterion-admission-fixture.ts'
import { assessFixture, mandateAssessmentState, proposedAssessmentState } from './workflow-spec-assessment-support.ts'
import { featureMandate, history, SCOPE } from './workflow-test-support.ts'

function selectPin(inputs: ActionInputs, pin: PinnedFileRef): ActionInputs {
  const manifest = { ...inputs.manifest, repositoryReferences: [pin] }
  return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
}

test('compatibility and criterion citations require both manifest selection and the exact observed Git bytes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-git-citations-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const bytes = 'Reload keeps the selected region.\n'
  const path = 'region.txt'
  try {
    git('init', '-q')
    git('remote', 'add', 'origin', `https://github.com/${SCOPE.repository}.git`)
    writeFileSync(join(cwd, path), bytes)
    git('add', '--', path)
    git('-c', 'user.name=Git Citations', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Seed evidence')
    const commit = git('rev-parse', 'HEAD')
    const code = { repository: SCOPE.repository, commit }
    const valid: PinnedFileRef = {
      source: 'git-file',
      ...code,
      path,
      digest: createHash('sha256').update(bytes).digest('hex'),
    }
    const wrongDigest = { ...valid, digest: createHash('sha256').update('Different evidence.\n').digest('hex') }
    const missingObject = { ...valid, commit: '0'.repeat(40) }
    const mandate = featureMandate()
    const accepted = mandateAssessmentState(mandate)
    const proposed = proposedAssessmentState(accepted, { body: 'Keep the selected region on reload' })
    const source = history([mandate])
    const review = acceptedActionInputs(mandate, 'review', undefined, {
      repository: code.repository,
      head: commit,
      base: commit,
      referenceCommit: commit,
    })
    const judgment = decision({ scope: SCOPE, findings: [] }).payload.judgment
    if (judgment.purpose !== 'review') throw new Error('expected review decision')
    const evidence = passingTest('C1', {
      target: criterionTarget('C1', accepted.ref),
      code,
      after: claimedRun(code, 0, 'PASS selected region survived reload', 'tool-region-after'),
    })
    const baseline = satisfied(evidence)
    const examined = baseline.examined[0]
    if (examined?.codeLink.method !== 'test') throw new Error('expected a test code link')
    const link = examined.codeLink
    const cases = Object.entries({ valid, wrongDigest, missingObject }).map(([label, pin]) => {
      const fixture = assessFixture(mandate, label, accepted, proposed, 'editorial', [source])
      const parsed = specAssessmentSchema.parse(fixture.result.payload.structured)
      if (parsed.compatibility.state !== 'consistent') throw new Error('expected a consistent assessment')
      const assessment = { ...parsed, compatibility: { ...parsed.compatibility, references: [pin] } }
      const result = {
        ...fixture.result,
        payload: {
          ...fixture.result.payload,
          inputs: selectPin(fixture.result.payload.inputs, pin),
          structured: assessment,
        },
      }
      const verdict = {
        ...baseline,
        examined: [{ ...examined, codeLink: { ...link, after: { ...link.after, references: [pin] } } }],
      }
      return { label, pin, result, assessment, verdict }
    })
    const decoded = history([mandate, ...cases.map(({ result }) => result)])
    const assertAdmission = (
      { label, pin, result, assessment, verdict }: (typeof cases)[number],
      authorized: boolean,
    ) => {
      const denial = expect.objectContaining({
        code: 'unknown-reference',
        message: expect.stringContaining('pinned source'),
      })
      const pins = result.payload.inputs.manifest.repositoryReferences
      expect(observationRefDiagnostics(label, pin, [decoded], pins)).toEqual(authorized ? [] : [denial])
      expect(constraintExaminationProblem(assessment.compatibility.examined, result, assessment, [decoded])).toBe(
        authorized ? null : 'Compatibility citation is not authenticated',
      )
      const assessed = criterionAssessmentForDecision(
        judgment,
        selectPin(review, pin),
        {
          declarations: [evidenceDeclaration(evidence)],
          evidence: [{ ref: examined.evidence, value: evidence }],
          verdicts: [verdict],
          diagnostics: [],
        },
        code,
        [decoded],
      )
      expect(assessed).toEqual({ forceRequestChanges: !authorized, diagnostics: authorized ? [] : [denial] })
    }
    for (const candidate of cases) assertAdmission(candidate, false)
    await observeHistoricalPins(decoded, {
      cwd,
      readAuthor: 'operator',
      gh: async () => {
        throw new Error('Fixture has no remote Git objects')
      },
    })
    for (const candidate of cases) assertAdmission(candidate, candidate.label === 'valid')
    expect(observationRefDiagnostics('unselected', valid, [decoded], [])).toEqual([
      expect.objectContaining({ code: 'unknown-reference' }),
    ])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
