import { expect, it } from 'vitest'
import { validateLocalFindingTarget } from '../finding-target.ts'
import { findingReportSchema } from '../record-values.ts'
import { criterionTarget, foreignOwn, invariantTarget, otherScope, scope, solo } from './criterion-admission-fixture.ts'

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
