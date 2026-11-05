import { describe, expect, it } from 'vitest'
import { acceptedActionInputs, fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { causeOriginalHistory, sisterRecords } from '../../testing/cause-input-fixture.ts'
import { actionInputDigest, selectorAdmitted, validateActionInputs } from '../action-input.ts'
import {
  readCauseDispositionHeads,
  resolveCauseSisterReceipt,
  validateCauseAdjudication,
} from '../cause-disposition.ts'
import { causeAdjudicationInputSchema } from '../cause-disposition-schema.ts'
import { validateLocalFindingTarget } from '../finding-target.ts'
import { buildRecord } from '../record-construction.ts'
import { recordFormatDiagnostic } from '../record-format.ts'
import { causeJudgmentSchema, decisionSchema, finalFindingSchema } from '../review-schema.ts'
import { criterionTarget, foreignOwn, own, scope, solo } from './criterion-admission-fixture.ts'
import { featureMandate, history, must } from './workflow-test-support.ts'

function retainedDisposition(id: string) {
  return must(
    buildRecord({
      version: 1,
      ...scope,
      recordId: id,
      runId: 'run',
      operationId: `op-${id}`,
      kind: 'cause-disposition',
      payload: {
        format: 'omp-build-cause-disposition/1',
        origin: own,
        subject: {
          kind: 'rule-error',
          source: { scope, kind: 'decision', recordId: 'decision' },
          diagnostic: { code: 'malformed', message: 'Unclassified output' },
        },
        previous: null,
        adjudication: null,
        outcome: { state: 'pending-blocking', reason: 'Needs resynthesis' },
        diagnostics: [],
      },
    }),
  )
}

const missing = { state: 'missing' as const, value: null, reason: 'Evidence not provided', references: [] }

describe('cause disposition contract', () => {
  it('pins cause state only at its complete payload selector', () => {
    expect(selectorAdmitted('cause-state', '/payload')).toBe(true)
    expect(selectorAdmitted('cause-state', '/payload/outcome')).toBe(false)
    expect(selectorAdmitted('cause-state', '/raw')).toBe(false)
  })
  it('rejects cause-state pins to another UW or an unrelated record kind', () => {
    const input = acceptedActionInputs(featureMandate(), 'review')
    const pin = {
      source: 'record' as const,
      role: 'cause-state' as const,
      selector: '/payload',
      digest: 'a'.repeat(64),
      record: { scope, kind: 'cause-disposition' as const, recordId: 'state' },
    }
    const withPin = (record: typeof pin.record) => {
      const manifest = { ...input.manifest, deliveryData: [{ ...pin, record }] }
      return { ...input, manifest, fingerprint: actionInputDigest(manifest) }
    }
    expect(validateActionInputs(withPin(pin.record)).ok).toBe(true)
    expect(validateActionInputs(withPin({ ...pin.record, scope: { ...scope, target: 'acme/app#99' } })).ok).toBe(false)
    const wrongKind = { ...pin, record: { ...pin.record, kind: 'decision' as const } }
    const manifest = { ...input.manifest, deliveryData: [wrongKind] }
    expect(validateActionInputs({ ...input, manifest, fingerprint: actionInputDigest(manifest) }).ok).toBe(false)
  })
  it('requires per-dimension evidence for supported judgments', () => {
    const unsupported = { state: 'supported', value: true, reason: 'Necessary', references: [] }
    expect(causeJudgmentSchema.safeParse({ necessary: unsupported, urgent: missing, tooLarge: missing }).success).toBe(
      false,
    )
    expect(causeJudgmentSchema.safeParse({ necessary: missing, urgent: missing, tooLarge: missing }).success).toBe(true)
  })
  it('keeps target explicit on both finding variants', () => {
    const usable = {
      id: 'f1',
      label: 'issue',
      impactReason: 'breaks save',
      state: 'usable',
      sourceFindingIds: ['o1'],
      description: 'save drops data',
    }
    expect(finalFindingSchema.safeParse(usable).success).toBe(false)
    expect(finalFindingSchema.safeParse({ ...usable, target: criterionTarget('C1') }).success).toBe(true)
    expect(
      finalFindingSchema.safeParse({
        id: 'f2',
        label: null,
        impactReason: 'malformed',
        state: 'unusable',
        sourceFindingIds: ['o2'],
        target: null,
      }).success,
    ).toBe(true)
  })
  it('marks old decisions and debt receipts explicitly incompatible', () => {
    expect(recordFormatDiagnostic({ kind: 'decision', payload: { judgment: { purpose: 'review' } } })?.code).toBe(
      'incompatible-format',
    )
    expect(recordFormatDiagnostic({ kind: 'debt-receipt', payload: { disposition: 'filed' } })?.code).toBe(
      'incompatible-format',
    )
    expect(
      decisionSchema.safeParse({
        purpose: 'correction',
        policy: { version: 'baseline' },
        sourceContributionIds: [],
        findings: [],
        causes: [],
      }).success,
    ).toBe(false)
  })
  it('requires the motivated adjudication input shape without a confirmation flag', () => {
    const input = {
      pending: { scope, recordId: 'pending', kind: 'cause-disposition' },
      rejectedFindingIds: ['f1'],
      judgment: null,
      reason: 'The source is contradicted',
      references: [],
    }
    expect(causeAdjudicationInputSchema.safeParse(input).success).toBe(true)
    expect(causeAdjudicationInputSchema.safeParse({ ...input, confirmed: true }).success).toBe(false)
  })
  it('reads durable heads from only the authenticated original history', () => {
    const { graph, held, operation, identity, receipt } = sisterRecords()
    const original = causeOriginalHistory([held, operation, receipt])
    const histories = [
      original,
      graph.history,
      history([identity], { repository: identity.repository, target: identity.target }),
    ]
    const catalogues = fixtureReviewClassCatalogues()
    const result = readCauseDispositionHeads({
      uw: { repository: held.repository, target: held.target },
      histories,
      catalogues,
    })
    expect(result.ok && result.value.map((record) => record.recordId)).toEqual([held.recordId])
    expect(readCauseDispositionHeads({ uw: scope, histories: [], catalogues }).ok).toBe(false)
    const incomplete = original
    expect(
      readCauseDispositionHeads({
        uw: { repository: held.repository, target: held.target },
        histories: [{ ...incomplete, source: { ...incomplete.source, complete: false } }, graph.history],
        catalogues,
      }).ok,
    ).toBe(false)
  })
  it('refuses duplicate initial subjects and does not turn a pending record into a sister receipt', () => {
    const first = retainedDisposition('first')
    const second = retainedDisposition('second')
    const observed = history([first, second], scope)
    const heads = readCauseDispositionHeads({
      uw: scope,
      histories: [observed],
      catalogues: fixtureReviewClassCatalogues(),
    })
    expect(heads.ok).toBe(false)
    if (!heads.ok) expect(heads.diagnostics.map((item) => item.code)).toContain('cause-duplicate-initial')
    expect(resolveCauseSisterReceipt({ disposition: first, histories: [observed] }).ok).toBe(false)
  })
  it('refuses a stale Spec target even when its criterion ID exists locally', () => {
    const context = { original: scope, effective: solo }
    expect(validateLocalFindingTarget({ context, target: criterionTarget('C1') }).ok).toBe(true)
    expect(validateLocalFindingTarget({ context, target: criterionTarget('C1', foreignOwn) }).ok).toBe(false)
  })
  it('does not turn an unmotivated rejection of an unidentified rule error into adjudication', () => {
    const pending = retainedDisposition('pending-rejection')
    const proposal = {
      format: 'omp-build-cause-adjudication-proposal/1' as const,
      operationId: 'adjudication',
      operation: 'adjudicate-cause' as const,
      uw: scope,
      pending: { scope, kind: 'cause-disposition' as const, recordId: pending.recordId },
      pendingDigest: '0'.repeat(64),
      rejectedFindingIds: [],
      judgment: null,
      reason: '',
      references: [],
    }
    const diagnostics = validateCauseAdjudication({
      proposal,
      pending,
      histories: [history([pending], scope)],
      context: { original: scope, effective: solo },
    })
    expect(diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['cause-adjudication-motivation', 'cause-adjudication-pending-mismatch']),
    )
  })
})
