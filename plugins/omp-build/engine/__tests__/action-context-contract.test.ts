import { describe, expect, test } from 'vitest'
import { missingContextOf, requestedSourceLocatorSchema } from '../action-context.ts'
import { ACTION_BINDING_FORMAT, ACTION_INPUT_FORMAT } from '../action-input-schema.ts'
import { producerOutputValid } from '../producer-schema.ts'
import { contributionSchema } from '../record-values.ts'
import { implementationOutputSchema, producerImplementationOutputSchema } from '../workflow-output-schema.ts'
import { criterionTarget } from './criterion-admission-fixture.ts'

const missing = [
  {
    locator: { kind: 'information-request', description: 'The accepted regional policy' },
    reason: 'The policy was not supplied',
    targets: [criterionTarget('C1')],
  },
]
const negative = { outcome: 'missing-context', missing }
const families = [
  'spec',
  'findings',
  'decision',
  'action-result',
  'spec-assessment',
  'plan',
  'plan-review',
  'ci-attribution',
  'uw-normalization',
] as const

const sha = 'a'.repeat(64)
const commit = 'b'.repeat(40)
const inputs = {
  format: ACTION_BINDING_FORMAT,
  manifest: {
    format: ACTION_INPUT_FORMAT,
    purpose: 'review',
    subject: { kind: 'standalone-pr', pullRequest: { repository: 'acme/app', target: 'acme/app#42' } },
    spec: { kind: 'absent', reason: 'standalone-review' },
    code: { repository: 'acme/app', base: commit, head: commit, referenceCommit: commit },
    acceptedSources: [],
    deliveryData: [],
    repositoryReferences: [],
    plugin: {
      name: 'omp-build',
      version: '0.15.0',
      repository: 'Roxabi/roxabi-plugins',
      commit,
      root: 'plugins/omp-build',
      files: [],
    },
    configuration: { version: '0.15.0', digest: sha, serialized: 'config' },
    expandedContext: [],
  },
  fingerprint: sha,
  stageSources: [],
}
const contribution = {
  content: 'findings',
  inventoryId: 'inventory-1',
  host: { origin: 'native', phase: 'panel', role: 'R-adversarial', slotId: 'panel-0', chunk: 0, childId: 'child-1' },
  rawAttempts: [],
  native: { completion: 'completed', strict: 'valid', raw: negative },
  structured: negative,
  findings: null,
}

describe('missing-context producer contract', () => {
  test.each(families)('%s accepts the common negative and rejects malformed negatives', (family) => {
    expect(producerOutputValid(family, negative)).toBe(true)
    expect(missingContextOf(negative)).toEqual(missing)
    for (const malformed of [
      { outcome: 'missing-context' },
      { outcome: 'missing-context', missing: [] },
      { outcome: 'missing-context', missing: [{ ...missing[0], reason: '' }] },
      { outcome: 'missing-context', missing: [{ ...missing[0], targets: null }] },
      { ...negative, extra: true },
    ]) {
      expect(producerOutputValid(family, malformed)).toBe(false)
      expect(missingContextOf(malformed)).toBeNull()
    }
  })

  test('implementation uses blocked with explicit criterion declarations, not the generic negative', () => {
    const blocked = {
      outcome: 'blocked',
      commitSHAs: [],
      commands: [],
      criteria: [{ target: criterionTarget('C1'), verification: 'unverified', reason: 'Policy unavailable' }],
      reason: 'Missing policy',
      missing,
    }
    expect(producerOutputValid('implementation', negative)).toBe(false)
    expect(producerOutputValid('implementation', blocked)).toBe(true)
    expect(implementationOutputSchema.safeParse(blocked).success).toBe(true)
    expect(missingContextOf(blocked)).toEqual(missing)
    const withoutCriteria = { outcome: 'blocked', commitSHAs: [], commands: [], reason: 'Missing policy', missing }
    for (const malformed of [
      withoutCriteria,
      { ...blocked, criteria: [{ target: criterionTarget('C1') }] },
      { ...blocked, missing: [] },
    ]) {
      expect(producerImplementationOutputSchema.safeParse(malformed).success).toBe(false)
      expect(implementationOutputSchema.safeParse(malformed).success).toBe(false)
      expect(producerOutputValid('implementation', malformed)).toBe(false)
    }
  })
})

describe('requested source locators', () => {
  test('accepts request descriptors without claiming a resolved source', () => {
    for (const locator of [
      { kind: 'file-request', repository: 'acme/app', path: 'src/policy.ts', revisionHint: null },
      {
        kind: 'record-request',
        repository: 'acme/app',
        target: 'acme/app#42',
        recordKind: null,
        requestedId: null,
        selector: null,
      },
      { kind: 'information-request', description: 'The regional policy' },
    ])
      expect(requestedSourceLocatorSchema.safeParse(locator).success).toBe(true)
  })

  test('rejects canonical identity, digest, nested source, and malformed descriptors', () => {
    const record = {
      kind: 'record-request',
      repository: 'acme/app',
      target: 'acme/app#42',
      recordKind: null,
      requestedId: null,
      selector: null,
    }
    for (const locator of [
      { ...record, recordId: 'canonical-record' },
      { ...record, digest: sha },
      { ...record, record: { recordId: 'canonical-record' } },
      { ...record, source: 'record' },
      { ...record, binding: {} },
      { kind: 'file-request', repository: 'acme/app', path: '../secret', revisionHint: null },
      { kind: 'file-request', repository: 'acme/app', path: 'src/policy.ts' },
    ])
      expect(requestedSourceLocatorSchema.safeParse(locator).success).toBe(false)
  })
})

describe('native missing-context contributions', () => {
  test('require a native host action binding for an authoritative slot', () => {
    const action = { actionId: 'review-action', inputs }
    expect(contributionSchema.safeParse({ ...contribution, host: { ...contribution.host, action } }).success).toBe(true)
    expect(contributionSchema.safeParse(contribution).success).toBe(false)
    expect(
      contributionSchema.safeParse({ ...contribution, host: { ...contribution.host, slotId: null } }).success,
    ).toBe(true)
    expect(
      contributionSchema.safeParse({ ...contribution, host: { ...contribution.host, origin: 'operator', action } })
        .success,
    ).toBe(false)
    expect(
      contributionSchema.safeParse({
        ...contribution,
        host: { ...contribution.host, action: { actionId: '', inputs } },
      }).success,
    ).toBe(false)
    expect(
      contributionSchema.safeParse({
        ...contribution,
        host: { ...contribution.host, action: { actionId: 'review-action', inputs: {} } },
      }).success,
    ).toBe(false)
  })
})
