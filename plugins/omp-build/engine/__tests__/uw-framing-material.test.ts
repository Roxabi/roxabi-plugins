import { expect, test } from 'vitest'
import { parseSpecMaterial, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { sealFramingMaterial } from '../../roxabi/uw-framing-material.ts'
import type { FramingMaterialCapture } from '../uw-framing-schema.ts'

const repository = 'acme/widgets'
const raw = rawSource('omp-session-entry:session/entry', '# Acceptance Criteria\n- C1: Preserve behavior\n', null)

test('operator material retains source identity without acquiring a native UW diagnostic location', () => {
  const material = parseSpecMaterial({ repository, material: 'm1', raw })
  expect(material.status).toBe('legacy')
  expect(material.analysis.criterionSources).toEqual([
    {
      id: 'C1',
      statement: 'Preserve behavior',
      span: { start: { line: 2, column: 1 }, end: { line: 2, column: 24 } },
      source: '- C1: Preserve behavior',
    },
  ])
  expect(material.diagnostics).toContainEqual(
    expect.objectContaining({
      code: 'spec-legacy-format',
      location: { kind: 'repository', repository },
    }),
  )
  for (const diagnostic of material.diagnostics) {
    expect(diagnostic.location).toEqual({ kind: 'repository', repository })
  }
})

test('material sealing rejects a mismatched body digest and non-entry reference', () => {
  const capture = {
    id: 'm1',
    producer: 'to-spec' as const,
    origin: { kind: 'operator-entry' as const, sessionId: 'session', entryId: 'entry' },
    raw,
  }
  const sealed = sealFramingMaterial(capture, repository)
  expect(sealed.ok).toBe(true)
  const tampered = sealFramingMaterial({ ...capture, raw: { ...raw, body: `${raw.body}tampered` } }, repository)
  expect(tampered.ok).toBe(false)
  if (!tampered.ok) expect(tampered.diagnostics[0].code).toBe('normalization-material-capture-mismatch')
  const external = sealFramingMaterial({ ...capture, raw: { ...raw, reference: 'acme/widgets#7' } }, repository)
  expect(external.ok).toBe(false)
  const malformed = sealFramingMaterial({ id: 'm1' } as unknown as FramingMaterialCapture, repository)
  expect(malformed.ok).toBe(false)
})
