import { expect, it } from 'vitest'
import { validateLocalFindingTarget } from '../finding-target.ts'
import { findingReportSchema } from '../record-values.ts'
import type { SpecEffective } from '../spec-effective-schema.ts'
import {
  criterionTarget,
  foreignOwn,
  invariantTarget,
  otherScope,
  own,
  scope,
  solo,
} from './criterion-admission-fixture.ts'

it('refuses a finding that cannot identify its accepted obligation or explicitly declare outside-Spec work', () => {
  const submitted = findingReportSchema.safeParse({
    findings: [
      {
        label: 'issue',
        description: 'Saving an address drops the selected region',
        location: { file: 'src/address.ts', line: 24 },
        rootCause: 'The write path reads the old region instead of the submitted value',
        symptomsEvidence: 'After selecting a different region and saving, reload restores the previous region',
      },
    ],
  })

  expect(submitted.success).toBe(false)
})

it('accepts only exact local obligations or explicit outside-Spec targets', () => {
  const context = { original: scope, effective: solo }
  expect(validateLocalFindingTarget({ context, target: criterionTarget('C1') }).ok).toBe(true)
  expect(validateLocalFindingTarget({ context, target: invariantTarget() }).ok).toBe(true)
  expect(validateLocalFindingTarget({ context, target: criterionTarget('C2') }).ok).toBe(false)
  expect(validateLocalFindingTarget({ context, target: criterionTarget('C1', foreignOwn) }).ok).toBe(false)
  expect(
    validateLocalFindingTarget({
      context,
      target: { format: 'omp-build-finding-target/1', kind: 'outside-spec', uw: scope, element: 'export' },
    }).ok,
  ).toBe(true)
  expect(
    validateLocalFindingTarget({
      context,
      target: { format: 'omp-build-finding-target/1', kind: 'outside-spec', uw: otherScope, element: 'export' },
    }).ok,
  ).toBe(false)
})

it('routes colliding invariant IDs only to their exact pinned owners', () => {
  const parentScope = { repository: 'acme/app', target: 'acme/app#41' }
  const grandScope = { repository: 'acme/app', target: 'acme/app#40' }
  const parent = {
    uw: parentScope,
    version: 'a'.repeat(64),
    sourceAccepted: { scope: parentScope, recordId: 'parent', kind: 'mandate' as const },
  }
  const grand = {
    uw: grandScope,
    version: 'b'.repeat(64),
    sourceAccepted: { scope: grandScope, recordId: 'grand', kind: 'mandate' as const },
  }
  const parentTarget = invariantTarget(parent)
  const grandTarget = invariantTarget(grand)
  if (parentTarget.kind !== 'invariant' || grandTarget.kind !== 'invariant')
    throw new Error('expected invariant targets')
  const effective: SpecEffective = {
    ...solo,
    versionVector: [own, parent, grand],
    inherited: {
      invariants: [
        { target: parentTarget, statement: 'parent invariant' },
        { target: grandTarget, statement: 'grand invariant' },
      ],
      exclusions: [],
    },
  }
  const context = { original: scope, effective }
  for (const target of [invariantTarget(), parentTarget, grandTarget])
    expect(validateLocalFindingTarget({ context, target }).ok).toBe(true)
  for (const target of [
    invariantTarget({ ...parent, version: 'c'.repeat(64) }),
    invariantTarget({ ...parent, sourceAccepted: { ...parent.sourceAccepted, recordId: 'other' } }),
    { ...parentTarget, id: 'I2' as const },
    invariantTarget(foreignOwn),
  ])
    expect(validateLocalFindingTarget({ context, target }).ok).toBe(false)
})
