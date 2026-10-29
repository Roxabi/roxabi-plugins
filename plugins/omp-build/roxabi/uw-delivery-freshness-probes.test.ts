import { expect, it } from 'vitest'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { parseRecord } from '../engine/record-construction.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { standaloneReviewInputs } from '../testing/action-input-fixtures.ts'
import { encodedAdmissionReviewGraph } from '../testing/record-admission.ts'
import {
  finding,
  projectionConfig,
  reviewRoot,
  SYNTHETIC_TAXONOMY,
  submission,
  TEST_HEAD,
  TEST_SCOPE,
} from '../testing/record-builders.ts'
import { contribution } from '../testing/record-decisions.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { assertCurrentOutputClosure, currentRootOutputRefs } from './uw-action-closure.ts'
import type { RecordInputRef, UwActionPorts, UwActionRequest } from './uw-action-contract.ts'
import { currentActionFingerprint } from './uw-action-inputs.ts'

const fixtures = roxabiWorkflowFixtures()
const baseline = standaloneReviewInputs()
function valid(record: CanonicalRecord): CanonicalRecord {
  const parsed = parseRecord(record)
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join('; '))
  return parsed.value
}
function request(expanded: RecordInputRef[] = []): UwActionRequest {
  return {
    actionId: 'root-review',
    purpose: 'review',
    subject: { kind: 'standalone-pr', pullRequest: TEST_SCOPE },
    code: { ...baseline.manifest.code, repository: TEST_SCOPE.repository },
    stageSources: [],
    expandedContext: expanded,
  }
}
function ref(record: CanonicalRecord, digest = 'd'.repeat(64)): RecordInputRef {
  return {
    source: 'record',
    record: {
      scope: { repository: record.repository, target: record.target },
      recordId: record.recordId,
      kind: record.kind,
    },
    selector: '/payload',
    digest,
  }
}

it('walks a schema-valid expanded wrapper citing a current output', () => {
  const root = valid(reviewRoot({ id: 'root-review' }))
  const output = valid(contribution({ id: 'contrib-x', inventoryId: 'root-review' }))
  const original = finding()
  const structured = { findings: [original], cited: { recordId: output.recordId, kind: output.kind } }
  const wrapper = valid(
    contribution({
      id: 'wrapper-r',
      inventoryId: null,
      findings: [{ id: 'wrapper-r:f0', attemptIndex: 0, data: original }],
      structured,
      rawAttempts: [submission({ id: 'child-wrapper-r', structuredOutput: { status: 'valid', data: structured } })],
    }),
  )
  const history = fixtures.historyFrom([root, output, wrapper])
  const closed = assertCurrentOutputClosure(request([ref(wrapper)]), [history], [])
  expect(closed.ok).toBe(false)
  if (!closed.ok) expect(closed.diagnostics.some((item) => item.code === 'self-output')).toBe(true)
})

it('includes a decision and review owned through the current contribution', () => {
  const graph = encodedAdmissionReviewGraph(projectionConfig(SYNTHETIC_TAXONOMY), { prefix: 'owned' })
  const refs = currentRootOutputRefs({ ...request(), actionId: graph.root.recordId }, [graph.history])
  expect(refs.map((item) => item.record.recordId)).toEqual(
    expect.arrayContaining([graph.synthesisContribution.recordId, graph.decision.recordId, graph.review.recordId]),
  )
})

it('admits an authenticated prior decision across correction head progression', () => {
  const graph = encodedAdmissionReviewGraph(projectionConfig(SYNTHETIC_TAXONOMY), {
    prefix: 'prior-correction',
    verdict: 'Request changes',
  })
  const decision = ref(graph.decision, canonicalValueDigest(graph.decision.payload))
  const correction: UwActionRequest = {
    ...request(),
    actionId: 'fix-apply',
    purpose: 'correction',
    code: { ...request().code, head: TEST_HEAD },
    stageSources: [decision],
  }
  expect(assertCurrentOutputClosure(correction, [graph.history], []).ok).toBe(true)
  expect(
    assertCurrentOutputClosure(
      { ...correction, code: { ...correction.code, head: 'c'.repeat(40) } },
      [graph.history],
      [],
    ).ok,
  ).toBe(true)
  expect(
    assertCurrentOutputClosure(
      { ...correction, stageSources: [{ ...decision, digest: '0'.repeat(64) }] },
      [graph.history],
      [],
    ).ok,
  ).toBe(false)
})

it('refuses an unreadable or changed expanded source after a readable fingerprint', async () => {
  const source = { stable: true }
  const wrapper = valid(contribution({ id: 'wrapper-r', inventoryId: null }))
  const input = request([ref(wrapper, canonicalValueDigest(source))])
  const bytes = new Uint8Array([1])
  const ports = (read: UwActionPorts['readRecord']): UwActionPorts => ({
    readCurrentActionFacts: async () => ({
      ok: true,
      value: {
        spec: baseline.manifest.spec,
        subject: input.subject,
        acceptedSources: [],
        deliveryData: [],
        plannedPaths: [],
        currentOutputs: [],
        configuration: baseline.manifest.configuration,
      },
    }),
    readRecord: read,
    readRecords: async (refs) => {
      const values = []
      for (const ref of refs) {
        const result = await read(ref)
        if (!result.ok) return result
        values.push(result.value)
      }
      return { ok: true, value: values }
    },
    readAccountedRecord: read,
    readPinnedFile: async () => ({ ok: true, value: bytes }),
    readCodeDiff: async () => ({ ok: true, value: bytes }),
    repositoryReferences: async () => ({ ok: true, value: [] }),
    plugin: {
      resolveInstalledPluginPin: async () => ({
        ok: true,
        value: {
          name: 'omp-build',
          version: '0.15.0',
          repository: 'Roxabi/roxabi-plugins',
          commit: 'c'.repeat(40),
          root: 'plugins/omp-build',
        },
      }),
      readInstalledFile: async () => ({ ok: true, value: bytes }),
    },
    snapshots: { create: async () => ({ ok: false, diagnostics: [] }) },
  })
  const readable = await currentActionFingerprint(
    input,
    ports(async () => ({ ok: true, value: source })),
  )
  expect(readable.ok).toBe(true)
  const missing = await currentActionFingerprint(
    input,
    ports(async () => ({
      ok: false,
      diagnostics: [{ code: 'record-unreadable', message: 'Expanded context is unreadable' }],
    })),
  )
  expect(missing.ok).toBe(false)
  const mutated = await currentActionFingerprint(
    input,
    ports(async () => ({ ok: true, value: { stable: false } })),
  )
  expect(mutated.ok).toBe(false)
})
