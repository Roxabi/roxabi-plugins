import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { observeHistoricalPins } from '../../adapters/github/historical-pins.ts'
import { acceptedActionInputs, observeFixtureCatalogue } from '../../testing/action-input-fixtures.ts'
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

function selectPin(inputs: ActionInputs, pin: PinnedFileRef, expansion?: PinnedFileRef): ActionInputs {
  const manifest = {
    ...inputs.manifest,
    repositoryReferences: [pin],
    expandedContext: expansion === undefined ? inputs.manifest.expandedContext : [expansion],
  }
  return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
}

test('Git citations require manifest selection and a commit, and ignore local blob replacements', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-git-citations-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const bytes = 'Reload keeps the selected region.\n'
  const path = 'region.txt'
  const contextPath = 'extra-context.txt'
  const contextBytes = 'Unrelated context that the action nevertheless selected.\n'
  try {
    git('init', '-q')
    git('remote', 'add', 'origin', `https://github.com/${SCOPE.repository}.git`)
    writeFileSync(join(cwd, path), bytes)
    writeFileSync(join(cwd, contextPath), contextBytes)
    git('add', '--', path, contextPath)
    git('-c', 'user.name=Git Citations', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Seed evidence')
    const commit = git('rev-parse', 'HEAD')
    const code = { repository: SCOPE.repository, commit }
    const valid: PinnedFileRef = {
      source: 'git-file',
      ...code,
      path,
      digest: createHash('sha256').update(bytes).digest('hex'),
    }
    const replacementBytes = 'Different evidence.\n'
    const replacementBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd,
      encoding: 'utf8',
      input: replacementBytes,
    }).trim()
    const expression = `${commit}:${path}`
    git('config', 'core.useReplaceRefs', 'true')
    git('replace', git('rev-parse', expression), replacementBlob)
    expect(git('cat-file', 'blob', expression)).toBe(replacementBytes.trim())
    const replacedDigest = { ...valid, digest: createHash('sha256').update(replacementBytes).digest('hex') }
    const missingObject = { ...valid, commit: '0'.repeat(40) }
    const tree = git('rev-parse', 'HEAD^{tree}')
    const treePin = { ...valid, commit: tree }
    expect(git('--no-replace-objects', 'cat-file', 'blob', `${tree}:${path}`)).toBe(bytes.trim())
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
    const validExpansion = {
      ...valid,
      path: contextPath,
      digest: createHash('sha256').update(contextBytes).digest('hex'),
    }
    const pinCases: { label: string; pin: PinnedFileRef; expansion?: PinnedFileRef; validAfterObservation: boolean }[] =
      [
        { label: 'valid', pin: valid, validAfterObservation: true },
        { label: 'replacedDigest', pin: replacedDigest, validAfterObservation: false },
        { label: 'missingObject', pin: missingObject, validAfterObservation: false },
        { label: 'treeInsteadOfCommit', pin: treePin, validAfterObservation: false },
        { label: 'completeExpansion', pin: valid, expansion: validExpansion, validAfterObservation: true },
        {
          label: 'absentExpansion',
          pin: valid,
          expansion: { ...validExpansion, path: 'absent.txt' },
          validAfterObservation: false,
        },
        {
          label: 'wrongExpansionDigest',
          pin: valid,
          expansion: { ...validExpansion, digest: valid.digest },
          validAfterObservation: false,
        },
      ]
    const cases = pinCases.map(({ label, pin, expansion, validAfterObservation }) => {
      const fixture = assessFixture(mandate, label, accepted, proposed, 'editorial', [source])
      const parsed = specAssessmentSchema.parse(fixture.result.payload.structured)
      if (parsed.compatibility.state !== 'consistent') throw new Error('expected a consistent assessment')
      const assessment = { ...parsed, compatibility: { ...parsed.compatibility, references: [pin] } }
      const result = {
        ...fixture.result,
        payload: {
          ...fixture.result.payload,
          inputs: selectPin(fixture.result.payload.inputs, pin, expansion),
          structured: assessment,
        },
      }
      const verdict = {
        ...baseline,
        examined: [{ ...examined, codeLink: { ...link, after: { ...link.after, references: [pin] } } }],
      }
      return { label, pin, expansion, result, assessment, verdict, validAfterObservation }
    })
    const decoded = observeFixtureCatalogue(history([mandate, ...cases.map(({ result }) => result)]))
    const assertAdmission = (
      { label, pin, expansion, result, assessment, verdict, validAfterObservation }: (typeof cases)[number],
      observed: boolean,
    ) => {
      const authorized = observed && validAfterObservation
      const citationAuthorized = observed && (authorized || expansion !== undefined)
      const unobservedPath = citationAuthorized && expansion !== undefined ? expansion.path : pin.path
      const denial = expect.objectContaining({
        code: 'unknown-reference',
        message: expect.stringContaining('pinned source'),
      })
      const pins = result.payload.inputs.manifest.repositoryReferences
      expect(observationRefDiagnostics(label, pin, [decoded], pins), label).toEqual(citationAuthorized ? [] : [denial])
      expect(constraintExaminationProblem(assessment.compatibility.examined, result, assessment, [decoded])).toBe(
        authorized ? null : 'Compatibility assessment inputs are not authenticated',
      )
      const assessed = criterionAssessmentForDecision(
        judgment,
        selectPin(review, pin, expansion),
        {
          declarations: [evidenceDeclaration(evidence)],
          evidence: [{ ref: examined.evidence, value: evidence }],
          verdicts: [verdict],
          diagnostics: [],
        },
        code,
        [decoded],
      )
      const expectedDiagnostic = expect.objectContaining({
        code: 'unconfirmed',
        message: expect.stringContaining(unobservedPath),
      })
      expect(assessed, label).toEqual({
        forceRequestChanges: !authorized,
        diagnostics: authorized ? [] : [expectedDiagnostic],
      })
    }
    for (const candidate of cases) assertAdmission(candidate, false)
    const fallbackExpressions: string[] = []
    await observeHistoricalPins(decoded, {
      cwd,
      readAuthor: 'operator',
      gh: async (_cwd, args) => {
        fallbackExpressions.push(...args.filter((arg) => arg.startsWith('expression=')))
        throw new Error('Fixture has no remote Git objects')
      },
    })
    expect(fallbackExpressions).not.toContain(`expression=${tree}:${path}`)
    expect(fallbackExpressions).toContain(`expression=${missingObject.commit}:${path}`)
    for (const candidate of cases) assertAdmission(candidate, true)
    expect(observationRefDiagnostics('unselected', valid, [decoded], [])).toEqual([
      expect.objectContaining({ code: 'unknown-reference' }),
    ])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
