import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { observeHistoricalPins } from '../../adapters/github/historical-pins.ts'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { executeDurableUwCommand } from '../../roxabi/uw-command-read.ts'
import {
  acceptedActionInputs,
  fixtureUwOperations,
  observeFixtureCatalogue,
} from '../../testing/action-input-fixtures.ts'
import { decision } from '../../testing/record-decisions.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest } from '../action-input.ts'
import type { ActionInputs, PinnedFileRef } from '../action-input-schema.ts'
import { criterionAssessmentForDecision } from '../criterion-decision.ts'
import { observationRefDiagnostics } from '../delivery-observation-authentication.ts'
import { hasObservedGitPin } from '../historical-git-pins.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { assessUwCompletion } from '../uw-completion.ts'
import { projectUwDelivery } from '../uw-delivery-projection.ts'
import { selectDeliveryReview } from '../uw-delivery-review.ts'
import { constraintExaminationProblem } from '../workflow-compatibility-citations.ts'
import { specAssessmentSchema } from '../workflow-output-schema.ts'
import {
  claimedRun,
  criterionTarget,
  evidenceDeclaration,
  passingTest,
  satisfied,
} from './criterion-admission-fixture.ts'
import { buildDeliveredLeaf } from './uw-delivered-leaf-fixture.ts'
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

function citeProducerTest(record: CanonicalRecord, pin: PinnedFileRef): CanonicalRecord {
  if (record.kind !== 'action-receipt' || record.payload.action !== 'implement' || record.payload.phase !== 'result')
    return record
  const output = record.payload.structured
  if (output?.outcome !== 'implemented') throw new Error('Expected a published implementation')
  const [declaration] = output.criteria
  if (declaration?.verification !== 'evidence') throw new Error('Expected a criterion declaration')
  const [evidence] = declaration.evidence
  if (evidence?.method !== 'test' || !('format' in evidence)) throw new Error('Expected captured test evidence')
  const after = { ...evidence.after, versionClaim: { ...evidence.after.versionClaim, references: [pin] } }
  const criteria = [{ ...declaration, evidence: [{ ...evidence, after }] }]
  return { ...record, payload: { ...record.payload, structured: { ...output, criteria } } }
}

test.each([
  ['producer', 'exact commit'],
  ['producer', 'wrong digest'],
  ['producer', 'tree OID'],
  ['reviewer', 'exact commit'],
] as const)('/uw verdicts checks unselected %s test citations: %s', async (source, variant) => {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-git-verdict-citation-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const path = 'region.test.ts'
  const bytes = 'Test accounts for reload.\n'
  const replacementBytes = 'Different test.\n'
  const repository = 'acme/app'
  try {
    git('init', '-q')
    git('remote', 'add', 'origin', `https://github.com/${repository}.git`)
    writeFileSync(join(cwd, path), bytes)
    git('add', '--', path)
    git('-c', 'user.name=Git Citations', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Seed test citation')
    const commit = git('rev-parse', 'HEAD')
    const tree = git('rev-parse', 'HEAD^{tree}')
    const replacement = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd,
      encoding: 'utf8',
      input: replacementBytes,
    }).trim()
    git('config', 'core.useReplaceRefs', 'true')
    git('replace', git('rev-parse', `${commit}:${path}`), replacement)
    expect(git('cat-file', 'blob', `${commit}:${path}`)).toBe(replacementBytes.trim())
    expect(git('--no-replace-objects', 'cat-file', 'blob', `${tree}:${path}`)).toBe(bytes.trim())
    const pin: PinnedFileRef = {
      source: 'git-file',
      repository,
      commit: variant === 'tree OID' ? tree : commit,
      path,
      digest: createHash('sha256')
        .update(variant === 'wrong digest' ? replacementBytes : bytes)
        .digest('hex'),
    }
    const fixture = await buildDeliveredLeaf(
      'Approve (clean)',
      42,
      false,
      source === 'producer'
        ? undefined
        : (row) => {
            const [examined] = row.examined
            if (examined?.codeLink.method !== 'test') throw new Error('Expected a test verdict')
            const link = examined.codeLink
            const codeLink = { ...link, after: { ...link.after, references: [pin] } }
            return { ...row, examined: [{ ...examined, codeLink }] }
          },
      // Keep the final historical review even when its citation would not be admitted today.
      (producer) => {
        if (source === 'reviewer') return producer
        const records = producer.records.map((record) => citeProducerTest(record, pin))
        const { comments } = roxabiWorkflowFixtures().historyFrom(records, 'operator', 'operator').source
        return { records, history: decodeHistory({ ...producer.history.source, comments }) }
      },
    )
    const { observation, effective, uw, pullRequest } = fixture
    const { repositoryReferences, plugin, expandedContext } = fixture.inputs.manifest
    expect([...repositoryReferences, ...plugin.files, ...expandedContext]).not.toContainEqual(pin)
    const options = {
      cwd,
      readAuthor: 'operator',
      gh: async () => {
        throw new Error('Fixture has no remote Git objects')
      },
    }
    for (const history of observation.histories) await observeHistoricalPins(history, options)
    expect(hasObservedGitPin(observation.histories, pin)).toBe(variant === 'exact commit')
    const admitted = selectDeliveryReview(observation, uw, pullRequest, effective, 'pull-request')
    const projected = projectUwDelivery(observation, assessUwCompletion(observation), uw)
    if (!projected.ok) throw new Error('Expected read-only delivery projection')
    const result = await executeDurableUwCommand(
      { kind: 'verdicts', repository, number: 42 },
      { ...fixtureUwOperations(), readDelivery: async () => projected },
    )
    const refused = expect.objectContaining({
      code: 'unknown-reference',
      message: expect.stringContaining('cites an unauthenticated pinned source'),
    })
    const valid = source === 'producer' && variant === 'exact commit'
    expect(admitted.ok).toBe(valid)
    expect(result.value).toMatchObject({
      status: 'verdicts',
      verdicts: valid ? [{ value: { target: { id: 'C1' }, verdict: 'satisfied' } }] : [],
    })
    if (valid) expect(projected.value.diagnostics).not.toContainEqual(refused)
    else expect(result.value).toMatchObject({ diagnostics: expect.arrayContaining([refused]) })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
