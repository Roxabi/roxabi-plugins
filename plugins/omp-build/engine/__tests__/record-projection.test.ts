import { describe, expect, test } from 'vitest'
import { finding, submission, TEST_HEAD } from '../../testing/record-builders.ts'
import { reviewGraph } from '../../testing/record-graphs.ts'
import { history } from '../../testing/record-history.ts'
import { producerJsonSchema } from '../producer-schema.ts'
import { projectRecord } from '../record-projection.ts'
import { actionResultSchema } from '../record-values.ts'
import { PROJECTION_CONFIG, refusalCodes } from './record-test-support.ts'

function replaceRecords<T extends { recordId: string }>(records: readonly T[], replacements: readonly T[]): T[] {
  const replacementById = new Map(replacements.map((record) => [record.recordId, record]))
  return records.map((record) => replacementById.get(record.recordId) ?? record)
}

describe('review projection policy context', () => {
  test('requires host policy context and does not accept candidate policy or taxonomy claims', () => {
    const graph = reviewGraph({ prefix: 'projection-context', empty: true })
    expect(refusalCodes(projectRecord(graph.review, graph.history, null))).toContain('unbound')
    expect(Reflect.apply(projectRecord, undefined, [graph.review, graph.history])).toMatchObject({ ok: false })
    expect(projectRecord(graph.review, graph.history, PROJECTION_CONFIG)).toMatchObject({ ok: true })

    const evidencePolicy = { version: 'evidence-v1' as const, acceptanceRef: 'candidate-self-acceptance' }
    const evidenceDecision = {
      ...graph.decision,
      payload: { ...graph.decision.payload, judgment: { ...graph.decision.payload.judgment, policy: evidencePolicy } },
    }
    const evidenceRoot = { ...graph.root, payload: { ...graph.root.payload, policy: evidencePolicy } }
    const evidenceSynthesis = { ...graph.synthesis, payload: { ...graph.synthesis.payload, policy: evidencePolicy } }
    const evidenceSource = {
      ...graph.synthesisContribution,
      payload: {
        ...graph.synthesisContribution.payload,
        rawAttempts: [
          submission({
            id: 'child-projection-context-decision',
            structuredOutput: { status: 'valid', data: evidenceDecision.payload.judgment },
          }),
        ],
        structured: evidenceDecision.payload.judgment,
      },
    }
    const evidenceRecords = replaceRecords(graph.records, [
      evidenceRoot,
      evidenceSynthesis,
      evidenceDecision,
      evidenceSource,
    ])
    expect(refusalCodes(projectRecord(graph.review, history(evidenceRecords), PROJECTION_CONFIG))).toContain(
      'policy-not-accepted',
    )

    const classified = reviewGraph({ prefix: 'projection-taxonomy' })
    const classifiedFinding = finding({
      classes: ['test-tautology'],
      rawCallsites: [{ file: 'src/widget.ts', line: 41 }],
    })
    const classifiedPanel = {
      ...classified.panel,
      payload: {
        ...classified.panel.payload,
        findings: [{ id: `${classified.panel.recordId}:f0`, attemptIndex: 0, data: classifiedFinding }],
        rawAttempts: [
          submission({
            id: 'child-projection-taxonomy-panel',
            structuredOutput: { status: 'valid', data: { findings: [classifiedFinding] } },
          }),
        ],
        structured: { findings: [classifiedFinding] },
      },
    }
    const classifiedHistory = history(replaceRecords(classified.records, [classifiedPanel]))
    expect(projectRecord(classified.review, classifiedHistory, PROJECTION_CONFIG)).toMatchObject({ ok: true })
    expect(
      refusalCodes(projectRecord(classified.review, classifiedHistory, { taxonomy: [], acceptedPolicy: null })),
    ).toContain('unknown-reference')
  })
})
describe('action-result proof and guard binding', () => {
  test('carries explicit repository proof paths, preserves failed null inventory, and binds unique guards to proof XOR', () => {
    const guard = {
      guardId: 'guard-one',
      productionGuard: 'region persists selected value',
      paths: ['src/region.ts'],
      intendedScenario: 'stale selected region reaches persistence',
    }
    const applied = {
      outcome: 'applied',
      commitSHAs: [TEST_HEAD],
      commands: [],
      guardInventory: [guard],
      proofPaths: ['src/region.ts'],
      proofToolCallId: 'bash-proof-1',
      proofUnavailableReason: null,
    }
    const proofOnlyApplied = { ...applied, guardInventory: [], proofPaths: [] }
    const failed = {
      outcome: 'failed',
      commitSHAs: [],
      commands: [],
      guardInventory: null,
      proofPaths: ['src/region.ts'],
      proofToolCallId: null,
      proofUnavailableReason: 'apply never reached a proof command',
    }
    const falsified = {
      facts: [
        {
          guardId: 'guard-one',
          removed: true,
          intendedScenario: guard.intendedScenario,
          proofFailed: true,
          proofToolCallId: 'bash-proof-2',
          proofUnavailableReason: null,
        },
      ],
      skippedReason: null,
      commands: [],
    }
    const duplicateGuards = { ...applied, guardInventory: [guard, guard] }
    const invalidAbsoluteProofPath = { ...applied, proofPaths: ['/var/tmp/proof.log'] }
    const invalidDriveRootedProofPath = { ...applied, proofPaths: ['C:\\proof.log'] }
    const invalidDotProofPath = { ...applied, proofPaths: ['./proof.log'] }
    const invalidTraversalProofPath = { ...applied, proofPaths: ['../proof.log'] }
    const invalidBackslashProofPath = { ...applied, proofPaths: ['src\\proof.log'] }
    const invalidFactProof = {
      ...falsified,
      facts: [{ ...falsified.facts[0], proofToolCallId: null, proofUnavailableReason: null }],
    }

    expect(actionResultSchema.safeParse(applied)).toMatchObject({
      success: true,
      data: { proofPaths: ['src/region.ts'], commands: [] },
    })
    expect(actionResultSchema.safeParse(proofOnlyApplied).success).toBe(true)
    expect(actionResultSchema.safeParse(failed)).toMatchObject({
      success: true,
      data: { proofPaths: ['src/region.ts'] },
    })
    expect(actionResultSchema.safeParse(falsified).success).toBe(true)
    expect(actionResultSchema.safeParse(duplicateGuards).success).toBe(false)
    expect(actionResultSchema.safeParse(invalidAbsoluteProofPath).success).toBe(false)
    expect(actionResultSchema.safeParse(invalidDriveRootedProofPath).success).toBe(false)
    expect(actionResultSchema.safeParse(invalidDotProofPath).success).toBe(false)
    expect(actionResultSchema.safeParse(invalidTraversalProofPath).success).toBe(false)
    expect(actionResultSchema.safeParse(invalidBackslashProofPath).success).toBe(false)
    expect(actionResultSchema.safeParse(invalidFactProof).success).toBe(false)
    expect(JSON.stringify(producerJsonSchema('action-result'))).toContain('proofPaths')
  })
})
