import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { observeHistoricalPins } from '../../adapters/github/historical-pins.ts'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { authenticatedReview, causeOriginalHistory } from '../../testing/cause-input-fixture.ts'
import { submission } from '../../testing/record-builders.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { historicalRecordFrames, observedComment } from '../../testing/record-history.ts'
import type { MissingContextOutput } from '../action-context.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { ActionInputs, RecordInputRef } from '../action-input-schema.ts'
import { resolveCauseActionInputs } from '../cause-adjudication.ts'
import { authenticateCauseCapture, decisionCauseCapture } from '../cause-capture-authentication.ts'
import { historicalRejectedFindingIds } from '../cause-effective-findings.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { reviewContextLineage } from '../review-context-lineage.ts'
import { reviewCandidateCode, reviewInputsFromInventory, reviewRootFromDecision } from '../review-inventory-input.ts'
import { originalContributionAction } from '../review-original-action.ts'
import { recordsOf } from '../workflow-control.ts'

function nativeHistory(seed: DecodedHistory, records: readonly CanonicalRecord[]) {
  const author = seed.source.expectedAuthor
  const comments = records.flatMap((record) => historicalRecordFrames(record))
  return decodeHistory({
    ...seed.source,
    comments: comments.map((body, index) =>
      observedComment({ locator: `comment-${index + 1}`, nativeId: String(index + 1), author, body }),
    ),
  })
}

function fixture(expandedContext: ActionInputs['manifest']['expandedContext']) {
  const { graph: seed, context } = authenticatedReview()
  const origin = causeOriginalHistory()
  const mandate = recordsOf(origin).find((record) => record.kind === 'mandate')
  const binding = recordsOf(seed.history).find((record) => record.kind === 'workflow-binding')
  if (!mandate || !binding) throw new Error('Expected native review authority')
  const manifest = { ...seed.inputs.manifest, expandedContext }
  const inputs = { ...seed.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  const graph = acceptedPullRequestReviewGraph({ mandate, binding, inputs })
  const source = nativeHistory(seed.history, [binding, ...graph.records])
  const records = recordsOf(source)
  const decision = records.find((record) => record.kind === 'decision')
  const panel = records.find((record) => record.recordId === graph.panel.recordId)
  const synthesis = records.find((record) => record.recordId === graph.synthesis.recordId)
  if (decision?.kind !== 'decision' || panel?.kind !== 'contribution' || synthesis?.kind !== 'review-attempt')
    throw new Error('Expected decoded decision and producer captures')
  const judgment = decision.payload.judgment
  if (judgment.purpose !== 'review') throw new Error('Expected review judgment')
  const synthesisInputs = synthesis.payload.slots[0]?.action?.inputs
  if (!synthesisInputs) throw new Error('Expected action inputs on the native synthesis slot')
  const capture: RecordInputRef = {
    source: 'record',
    record: { scope: source.source.scope, kind: 'review-attempt', recordId: synthesis.recordId },
    selector: '/payload/slots/0/action/inputs',
    digest: canonicalValueDigest(synthesisInputs),
  }
  return { inputs, source, origin, context, decision, judgment, panel, capture }
}

function observeConsumers(sample: ReturnType<typeof fixture>, histories: readonly DecodedHistory[]) {
  const { source, decision, judgment, panel, inputs, capture, context } = sample
  const catalogues = fixtureReviewClassCatalogues()
  return {
    reviewRoot: reviewRootFromDecision(decision, source, histories).ok,
    reviewSnapshot: reviewInputsFromInventory(judgment, source, histories) !== null,
    reviewCode: reviewCandidateCode(judgment, source, histories) !== null,
    originalContribution: originalContributionAction(panel, source, histories).ok,
    causeSynthesis: resolveCauseActionInputs({ decision, history: source, histories, context }).ok,
    causeRecoveryCapture: decisionCauseCapture(decision, histories).ok,
    causeSelectedCapture: authenticateCauseCapture({
      source: { kind: 'decision', decision },
      capture,
      histories,
      catalogues,
      context,
    }).ok,
    causeReviewVeto: historicalRejectedFindingIds({ action: inputs, decision, histories, catalogues }).ok,
  }
}

function expected(authenticated: boolean) {
  return {
    reviewRoot: authenticated,
    reviewSnapshot: authenticated,
    reviewCode: authenticated,
    originalContribution: authenticated,
    causeSynthesis: authenticated,
    causeRecoveryCapture: authenticated,
    causeSelectedCapture: authenticated,
    causeReviewVeto: authenticated,
  }
}

test.each(['valid', 'absent record', 'wrong scope', 'wrong selector', 'wrong digest'] as const)(
  'review and cause authorities require the exact expanded record value: %s',
  (variant) => {
    const origin = causeOriginalHistory()
    const mandate = recordsOf(origin).find((record) => record.kind === 'mandate')
    if (!mandate) throw new Error('Expected decoded mandate')
    const ref: RecordInputRef = {
      source: 'record',
      record: {
        scope: variant === 'wrong scope' ? { ...origin.source.scope, target: 'acme/app#999' } : origin.source.scope,
        kind: 'mandate',
        recordId: variant === 'absent record' ? 'unobserved-mandate' : mandate.recordId,
      },
      selector: variant === 'wrong selector' ? '/payload/missing' : '/payload',
      digest: variant === 'wrong digest' ? 'f'.repeat(64) : canonicalValueDigest(mandate.payload),
    }
    const sample = fixture([ref])
    expect(sample.source.diagnostics).toEqual([])
    expect(observeConsumers(sample, [sample.source, sample.origin])).toEqual(expected(variant === 'valid'))
  },
)

test('an observed negative still refuses a final even when its own historical expansion is unconfirmed', () => {
  const origin = causeOriginalHistory()
  const sample = fixture([
    {
      source: 'record',
      record: { scope: origin.source.scope, kind: 'mandate', recordId: 'unobserved-expansion' },
      selector: '/payload',
      digest: 'f'.repeat(64),
    },
  ])
  const negative: MissingContextOutput = {
    outcome: 'missing-context',
    missing: [
      {
        locator: { kind: 'information-request', description: 'deployment region' },
        reason: 'not supplied',
        targets: [],
      },
    ],
  }
  const panel = {
    ...sample.panel,
    payload: {
      ...sample.panel.payload,
      findings: null,
      structured: negative,
      rawAttempts: [submission({ structuredOutput: { data: negative } })],
    },
  }
  const observed = nativeHistory(
    sample.source,
    recordsOf(sample.source).map((record) => (record.recordId === panel.recordId ? panel : record)),
  )
  const lineage = reviewContextLineage(
    observed,
    new Map(recordsOf(observed).map((record) => [record.recordId, record])),
    [observed, origin],
  )
  expect(lineage.superseded.size).toBe(0)
  expect(lineage.diagnostics).toEqual([
    expect.objectContaining({ code: 'incomplete', message: expect.stringContaining('has a context-negative result') }),
  ])
})

test('review and cause authorities require verified Git bytes for an expanded file', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-historical-review-cause-'))
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    const repository = 'acme/app'
    const path = 'expansion.txt'
    const bytes = 'Review context from a committed blob.\n'
    git('init', '-q')
    git('remote', 'add', 'origin', `https://github.com/${repository}.git`)
    writeFileSync(join(cwd, path), bytes)
    git('add', '--', path)
    git('-c', 'user.name=Review Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Record context')
    const commit = git('rev-parse', 'HEAD')
    writeFileSync(join(cwd, path), 'Uncommitted replacement.\n')
    const ref = {
      source: 'git-file' as const,
      repository,
      commit,
      path,
      digest: createHash('sha256').update(bytes).digest('hex'),
    }
    for (const pin of [ref, { ...ref, path: 'absent.txt' }, { ...ref, digest: 'f'.repeat(64) }]) {
      const sample = fixture([pin])
      expect(observeConsumers(sample, [sample.source, sample.origin])).toEqual(expected(false))
      const source = await observeHistoricalPins(sample.source, {
        cwd,
        readAuthor: sample.source.source.expectedAuthor,
        gh: async () => {
          throw new Error('The temporary Git repository has no remote objects')
        },
      })
      expect(observeConsumers({ ...sample, source }, [source, sample.origin])).toEqual(expected(pin === ref))
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
