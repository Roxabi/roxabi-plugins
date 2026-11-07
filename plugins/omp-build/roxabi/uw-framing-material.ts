import type { IssueSpecAnalysis, ParsedIssueSpec } from '../adapters/github-native/uw-spec.ts'
import { canonicalValueDigest, framingMaterialCaptureSchema, parseSpecMaterial, specDigest } from '../dist/contracts.js'
import type { UwResult } from '../engine/uw-diagnostics.ts'
import type { FramingAggregateInput, FramingMaterialCapture } from '../engine/uw-framing-schema.ts'

function refusal(repository: string, code: string, message: string): UwResult<never> {
  return { ok: false, diagnostics: [{ code, message, location: { kind: 'repository', repository }, related: [] }] }
}

export type FramingMaterial = FramingMaterialCapture & {
  parser: { status: ParsedIssueSpec['status']; analysis: IssueSpecAnalysis; analysisDigest: string }
}

export function sealFramingMaterial(capture: FramingMaterialCapture, repository: string): UwResult<FramingMaterial> {
  const parsed = framingMaterialCaptureSchema.safeParse(capture)
  if (
    !parsed.success ||
    parsed.data.raw.reference !== `omp-session-entry:${parsed.data.origin.sessionId}/${parsed.data.origin.entryId}` ||
    parsed.data.raw.lastEditedAt !== null ||
    parsed.data.raw.bodySha256 !== specDigest(parsed.data.raw.body)
  ) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'normalization-material-capture-mismatch',
          message: 'Material capture does not match its operator entry or body digest',
          location: { kind: 'repository', repository },
          related: [],
        },
      ],
    }
  }
  const result = parseSpecMaterial({ repository, material: parsed.data.id, raw: parsed.data.raw })
  return {
    ok: true,
    value: {
      ...parsed.data,
      parser: {
        status: result.status,
        analysis: result.analysis,
        analysisDigest: canonicalValueDigest(result.analysis),
      },
    },
  }
}
function convertedMaterial(
  capture: FramingMaterialCapture,
  repository: string,
  conversion: 'not-applicable' | 'converted',
) {
  const material = sealFramingMaterial(capture, repository)
  return material.ok ? { ok: true as const, value: { ...material.value, conversion } } : material
}
export type SealedMaterial = Extract<ReturnType<typeof convertedMaterial>, { ok: true }>['value']

export function sealMaterials(aggregate: FramingAggregateInput, repository: string): UwResult<SealedMaterial[]> {
  const materials: SealedMaterial[] = []
  const materialIds = new Set<string>()
  const conversion = aggregate.kind === 'wayfinder' ? 'not-applicable' : 'converted'
  for (const capture of aggregate.source.materials) {
    if (materialIds.has(capture.id))
      return refusal(repository, 'normalization-source-origin-duplicate', 'Material IDs must be unique')
    materialIds.add(capture.id)
    const material = convertedMaterial(capture, repository, conversion)
    if (!material.ok) return material
    materials.push(material.value)
  }
  return { ok: true, value: materials }
}
