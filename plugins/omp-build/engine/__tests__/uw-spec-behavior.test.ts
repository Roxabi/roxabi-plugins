import { expect, test } from 'vitest'
import { diagnosticSchema } from '../record-values.ts'
import { toDiagnostic } from '../uw-diagnostics.ts'
import { canonicalSpec } from '../uw-spec.ts'

test('keeps presentation whitespace out of canonical Spec version while preserving significant whitespace and raw diagnostic detail', () => {
  const base = {
    format: 'omp-build-spec-content/1' as const,
    criteria: [{ id: 'C1' as const, statement: 'keep  spaces' }],
    invariants: [{ id: 'I1' as const, statement: 'code  space' }],
    exclusions: [],
    openQuestions: [],
    sections: { origin: 'Origin', context: 'Context', change: 'Change' },
  }
  const canonicalBase = canonicalSpec(base)
  const presentation = canonicalSpec({ ...base, sections: { ...base.sections, origin: '\nOrigin\r\n' } })
  const meaningful = canonicalSpec({ ...base, criteria: [{ id: 'C1', statement: 'keep three spaces' }] })
  if (!canonicalBase.ok || !presentation.ok || !meaningful.ok) throw new Error('expected canonical Specs')
  expect(presentation.value.version).toBe(canonicalBase.value.version)
  expect(meaningful.value.version).not.toBe(presentation.value.version)
  const bridged = toDiagnostic({
    code: 'graph-incomplete',
    message: 'missing page',
    location: { kind: 'native', uw: { repository: 'R/r', target: '1' }, connection: 'blockers', page: 2 },
    related: [],
  })
  expect(diagnosticSchema.safeParse(bridged).success).toBe(true)
})
