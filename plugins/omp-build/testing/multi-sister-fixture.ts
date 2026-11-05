import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { actionInputDigest } from '../engine/action-input.ts'
import { assessCauseDispositions } from '../engine/cause-disposition.ts'
import { buildRecord, parseRecord } from '../engine/record-construction.ts'
import { createReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import { canonicalSpec } from '../engine/uw-spec.ts'
import { recordsOf } from '../engine/workflow-control.ts'
import { encodeCriterionRecords } from './criterion-approval.ts'
import { submission } from './record-builders.ts'
import { acceptedPullRequestReviewGraph } from './record-graphs.ts'
import { operation } from './record-history.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from './roxabi-presets.ts'

function must<T>(
  result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string; message: string }[] },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.value
}

/** One or two independently actionable sister causes from one authenticated review. */
export function multiSisterFixture(count: 1 | 2 = 2, disposition: 'sister-blocking' | 'report' = 'sister-blocking') {
  const fixtures = roxabiWorkflowFixtures()
  const uw = { repository: 'acme/app', target: 'acme/app#42' }
  const pr = { repository: 'acme/app', target: 'acme/app#44' }
  const spec = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: [{ id: 'C1', statement: 'Save the selected region' }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    }),
  )
  const body = renderIssueSpecBody(spec, { complexity: 5 })
  const parsed = parseIssueSpecBody({ uw, raw: rawSource(uw.target, body, '2026-10-27T12:00:00.000Z') })
  if (parsed.status !== 'conformant') throw new Error('fixture native Spec is not conformant')
  const mandate = fixtures.featureMandate(uw, {
    recordId: 'mandate-42',
    ownSpec: fixtures.ownSpecFromSnapshot(uw, parsed.snapshot),
  })
  const binding = fixtures.workflowBinding(pr, mandate, 'feat/42-save', 'main')
  const label = disposition === 'report' ? ('suggestion' as const) : ('issue' as const)
  const base = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'admission-source', label })
  const evidence = {
    source: 'git-file' as const,
    repository: uw.repository,
    commit: '1'.repeat(40),
    path: 'src/region.ts',
    digest: 'a'.repeat(64),
  }
  const catalogueBytes = readFileSync(new URL('../skills/dev-review/review-classes.yml', import.meta.url))
  const plugin = base.inputs.manifest.plugin
  const catalogueRef = {
    source: 'git-file' as const,
    repository: plugin.repository,
    commit: plugin.commit,
    path: `${plugin.root}/skills/dev-review/review-classes.yml`,
    digest: createHash('sha256').update(catalogueBytes).digest('hex'),
  }
  const catalogues = createReviewClassCatalogues([{ ref: catalogueRef, contents: { ok: true, value: catalogueBytes } }])
  const manifest = {
    ...base.inputs.manifest,
    repositoryReferences: [evidence],
    plugin: { ...plugin, files: [...plugin.files.filter((file) => file.path !== catalogueRef.path), catalogueRef] },
  }
  const inputs = { ...base.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  if (inputs.manifest.spec.kind !== 'accepted') throw new Error('fixture Spec not accepted')
  const graph = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'admission-source', inputs, label })
  const context = { original: uw, effective: inputs.manifest.spec.effective }
  const original = graph.panel.payload.findings?.[0]
  const firstFinding = graph.decision.payload.judgment.findings[0]
  const baseCause = graph.decision.payload.judgment.causes[0]
  const supported = (value: boolean) => ({
    state: 'supported' as const,
    value,
    reason: 'The selected source supports this judgment',
    references: [evidence],
  })
  const firstCause = baseCause && {
    ...baseCause,
    judgment: { necessary: supported(disposition !== 'report'), urgent: supported(true), tooLarge: supported(true) },
    proposedDisposition: disposition,
  }
  if (!original || !firstFinding || !firstCause)
    throw new Error('multi-sister fixture requires a source finding and cause')
  if (original.data === null || typeof original.data !== 'object' || Array.isArray(original.data))
    throw new Error('multi-sister original finding is not an object')
  const secondOriginal = {
    ...original,
    id: `${graph.panel.recordId}:f1`,
    data: {
      ...original.data,
      description: 'Widget reload discards the persisted region.',
      location: { file: 'src/widget.ts', line: 42 },
      rootCause: 'The reload path reads a stale cache.',
      symptomsEvidence: 'The selected region changes after reloading.',
    },
  }
  const findings = count === 1 ? [original] : [original, secondOriginal]
  const panel = must(
    parseRecord({
      ...graph.panel,
      payload: {
        ...graph.panel.payload,
        findings,
        structured: { findings: findings.map((item) => item.data) },
        rawAttempts: [
          submission({
            id: `child-${graph.panel.recordId}`,
            structuredOutput: { status: 'valid', data: { findings: findings.map((item) => item.data) } },
          }),
        ],
      },
    }),
  )
  const secondFinding = {
    ...firstFinding,
    id: `${firstFinding.id}-second`,
    sourceFindingIds: [secondOriginal.id],
    description: 'Reload the persisted region rather than a stale cache.',
  }
  const secondCause = {
    ...firstCause,
    id: `${firstCause.id}-second`,
    findingIds: [secondFinding.id],
    title: 'Restore widget reload',
    mechanism: 'The reload path reads stale cache data.',
    fix: 'Reload the persisted selected region.',
  }
  const judgment = {
    ...graph.decision.payload.judgment,
    findings: count === 1 ? [firstFinding] : [firstFinding, secondFinding],
    causes: count === 1 ? [firstCause] : [firstCause, secondCause],
  }
  const decision = must(parseRecord({ ...graph.decision, payload: { ...graph.decision.payload, judgment } }))
  const synthesis = must(
    parseRecord({
      ...graph.synthesisContribution,
      payload: {
        ...graph.synthesisContribution.payload,
        structured: judgment,
        rawAttempts: [
          submission({
            id: `child-${graph.synthesisContribution.recordId}`,
            structuredOutput: { status: 'valid', data: judgment },
          }),
        ],
      },
    }),
  )
  if (panel.kind !== 'contribution' || decision.kind !== 'decision' || synthesis.kind !== 'contribution')
    throw new Error('multi-sister source record kinds changed')
  const history = {
    ...graph.history,
    operations: graph.history.operations.map((entry) => {
      if (entry.recordId === panel.recordId) return operation(panel)
      if (entry.recordId === decision.recordId) return operation(decision)
      if (entry.recordId === synthesis.recordId) return operation(synthesis)
      return entry
    }),
  }
  const own = fixtures.historyFrom([mandate], 'automation')
  const assessment = must(
    assessCauseDispositions({
      context,
      source: { kind: 'decision', decision },
      histories: [own, history],
      catalogues,
      adjudications: [],
    }),
  )
  const outcomes = assessment.outcomes.filter((item) => item.subject.kind === 'cause')
  if (
    outcomes.length !== count ||
    outcomes.some((item) => item.outcome.state !== 'final' || item.outcome.disposition !== disposition)
  )
    throw new Error(`expected ${count} authenticated ${disposition} causes: ${JSON.stringify(assessment.outcomes)}`)
  const dispositions = outcomes.map((payload, index) => {
    const record = must(
      buildRecord({
        version: 1,
        ...context.original,
        recordId: `multi-sister-${index + 1}`,
        runId: 'multi-sister',
        operationId: `multi-sister-disposition-${index + 1}`,
        kind: 'cause-disposition',
        payload,
      }),
    )
    if (record.kind !== 'cause-disposition') throw new Error('expected disposition')
    return record
  })
  const source = encodeCriterionRecords(
    recordsOf(history).filter((record) => record.kind !== 'review'),
    history.source.scope,
    roxabiRecordFixtures().projection,
    'automation',
    [own],
  ).history
  return { graph, context, mandate, source, dispositions, body, own, catalogueBytes, catalogueRef, catalogues }
}
