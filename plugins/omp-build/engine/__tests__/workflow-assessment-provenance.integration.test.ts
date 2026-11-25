import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { observeHistoricalPins } from '../../adapters/github/historical-pins.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { ActionInputs } from '../action-input-schema.ts'
import { authenticateHistoricalActionInputs } from '../historical-action-inputs.ts'
import { buildRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { workflowContextTerminal } from '../workflow-context-terminal.ts'
import { assessFixture, mandateAssessmentState, shippedFeatureMandate } from './workflow-spec-assessment-support.ts'
import { history, must, SCOPE } from './workflow-test-support.ts'

function expandedAssessment(commit: string, policyDigest: string) {
  const mandated = shippedFeatureMandate()
  const state = mandateAssessmentState(mandated)
  const proposed = {
    snapshot: state.snapshot,
    tier: state.tier,
    children: state.children,
    inheritedOwnSpecRefs: state.inheritedOwnSpecRefs,
    coverage: state.coverage,
  }
  const prior = assessFixture(mandated, 'negative', state, proposed, 'editorial', [history([mandated])])
  if (
    prior.start.kind !== 'action-receipt' ||
    prior.start.payload.action !== 'assess-spec' ||
    prior.start.payload.phase !== 'start'
  )
    throw new Error('Expected assessment START')
  const startPayload = prior.start.payload
  const negativePayload = {
    ...prior.result.payload,
    structured: {
      outcome: 'missing-context' as const,
      missing: [
        { locator: { kind: 'information-request' as const, description: 'policy' }, reason: 'needed', targets: [] },
      ],
    },
  }
  const negative = must(buildRecord({ ...prior.result, payload: negativePayload }))
  const lineage = {
    source: 'record' as const,
    record: { scope: SCOPE, kind: 'action-receipt' as const, recordId: negative.recordId },
    selector: '/payload',
    digest: canonicalValueDigest(negative.payload),
  }
  const sameNegativeSelector = {
    ...lineage,
    selector: '/payload/structured',
    digest: canonicalValueDigest(negativePayload.structured),
  }
  const added = {
    source: 'git-file' as const,
    repository: SCOPE.repository,
    commit,
    path: 'policy.txt',
    digest: policyDigest,
  }
  const manifest = { ...startPayload.inputs.manifest, expandedContext: [lineage, added] }
  const stageSources = startPayload.inputs.stageSources
  function successor(changedManifest: ActionInputs['manifest'], changedSources = stageSources) {
    const inputs = {
      ...startPayload.inputs,
      manifest: changedManifest,
      fingerprint: actionInputDigest(changedManifest),
      stageSources: changedSources,
    }
    const actionId = 'expanded-action'
    const start = must(
      buildRecord({
        ...prior.start,
        kind: 'action-receipt',
        recordId: 'expanded-start',
        operationId: 'expanded-op',
        payload: { ...startPayload, actionId, inputs },
      }),
    )
    const startRef = { scope: SCOPE, kind: start.kind, recordId: start.recordId }
    const result = must(
      buildRecord({
        ...prior.result,
        recordId: 'expanded-result',
        operationId: 'expanded-result-op',
        payload: { ...prior.result.payload, actionId, inputs, start: startRef },
      }),
    )
    return { start, result, inputs }
  }
  return {
    mandated,
    prior: [mandated, prior.start, negative],
    manifest,
    lineage,
    sameNegativeSelector,
    added,
    successor,
  }
}

test('historical assessments require observed bytes and intact expanded-context provenance', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-historical-assessment-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const requests: string[][] = []
  const gh: Gh = async (_cwd, args) => {
    requests.push(args)
    const catalogue = fixtureCatalogueGhResponse(args)
    if (catalogue !== null) return catalogue
    throw new Error('Fixture has no remote policy blob')
  }
  const observe = (records: CanonicalRecord[]) =>
    observeHistoricalPins(history(records), { cwd, gh, readAuthor: 'operator' })
  const retainedPolicy = 'Retained policy\n'
  const currentPolicy = 'Uncommitted replacement policy\n'
  try {
    git('init', '-q')
    git('config', 'user.name', 'Historical Assessment')
    git('config', 'user.email', 'fixture@example.test')
    git('remote', 'add', 'origin', `https://github.com/${SCOPE.repository}.git`)
    git('commit', '-qm', 'before the policy existed', '--allow-empty')
    const missingCommit = git('rev-parse', 'HEAD')
    const path = join(cwd, 'policy.txt')
    writeFileSync(path, retainedPolicy)
    git('add', '--', 'policy.txt')
    git('commit', '-qm', 'retain the policy')
    const commit = git('rev-parse', 'HEAD')
    writeFileSync(path, currentPolicy)

    const { mandated, prior, manifest, lineage, sameNegativeSelector, added, successor } = expandedAssessment(
      commit,
      createHash('sha256').update(retainedPolicy).digest('hex'),
    )
    const mandateRef = { scope: SCOPE, kind: mandated.kind, recordId: mandated.recordId }
    const { start, result } = successor({ ...manifest, expandedContext: [lineage, sameNegativeSelector, added] })
    const pending = await observe([...prior, start])
    expect(workflowContextTerminal(pending, 'assess-spec', mandateRef)).toBe('uncertain')
    expect(resolveAcceptedSpec(mandated, [pending])).toMatchObject({ ok: false })
    const observed = await observe([...prior, start, result])
    expect(workflowContextTerminal(observed, 'assess-spec', mandateRef)).toBe('clear')
    expect(resolveAcceptedSpec(mandated, [observed])).toMatchObject({
      ok: true,
      spec: { ref: { sourceAccepted: { scope: SCOPE, kind: result.kind, recordId: result.recordId } } },
    })

    const sameNegative = successor({ ...manifest, expandedContext: [lineage, sameNegativeSelector] })
    const repeated = await observe([...prior, sameNegative.start, sameNegative.result])
    expect(authenticateHistoricalActionInputs(sameNegative.inputs, [repeated]).ok).toBe(true)
    expect(workflowContextTerminal(repeated, 'assess-spec', mandateRef), 'selector into the same negative').toBe(
      'missing',
    )
    expect(resolveAcceptedSpec(mandated, [repeated])).toMatchObject({
      ok: false,
      evidence: [{ code: 'action-context-missing' }],
    })

    const stageRef = { ...lineage, record: { ...lineage.record, recordId: 'other-stage' } }
    const selected = {
      source: 'record' as const,
      record: { scope: SCOPE, kind: mandated.kind, recordId: mandated.recordId },
      selector: '/payload',
      digest: canonicalValueDigest(mandated.payload),
    }
    const recordSuccessor = successor({ ...manifest, expandedContext: [lineage, added, selected] })
    const recordObserved = await observe([...prior, recordSuccessor.start, recordSuccessor.result])
    expect(workflowContextTerminal(recordObserved, 'assess-spec', mandateRef)).toBe('clear')
    const cases = [
      {
        name: 'changed negative digest',
        manifest: { ...manifest, expandedContext: [{ ...lineage, digest: 'd'.repeat(64) }, added] },
      },
      { name: 'no new context', manifest: { ...manifest, expandedContext: [lineage] } },
      { name: 'changed authority', manifest: { ...manifest, code: { ...manifest.code, head: 'd'.repeat(40) } } },
      { name: 'changed stage sources', manifest, stageSources: [stageRef] },
      ...(
        [
          ['absent record', { ...selected, record: { ...selected.record, recordId: 'absent' } }],
          [
            'wrong-scope record',
            { ...selected, record: { ...selected.record, scope: { ...SCOPE, target: `${SCOPE.repository}#43` } } },
          ],
          ['wrong record selector', { ...selected, selector: '/payload/absent' }],
          ['wrong record digest', { ...selected, digest: 'd'.repeat(64) }],
        ] as const
      ).map(([name, pin]) => ({
        name,
        manifest: { ...manifest, expandedContext: [lineage, added, pin] },
      })),
      {
        name: 'missing policy blob',
        manifest: { ...manifest, expandedContext: [lineage, { ...added, commit: missingCommit }] },
      },
      {
        name: 'wrong policy digest',
        manifest: {
          ...manifest,
          expandedContext: [lineage, { ...added, digest: createHash('sha256').update(currentPolicy).digest('hex') }],
        },
      },
    ]
    for (const item of cases) {
      const changed = successor(item.manifest, 'stageSources' in item ? item.stageSources : undefined)
      const issue = await observe([...prior, changed.start, changed.result])
      expect(workflowContextTerminal(issue, 'assess-spec', mandateRef), item.name).toBe('missing')
      expect(resolveAcceptedSpec(mandated, [issue]), item.name).toMatchObject({
        ok: false,
        evidence: [{ code: 'action-context-missing' }],
      })
    }
    expect(requests).toContainEqual(expect.arrayContaining([`expression=${missingCommit}:policy.txt`]))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
