import { canonicalValueDigest } from '../engine/action-input.ts'
import type { NativeTask } from '../omp/review-runtime/contracts.ts'
import { fixtureSpecRow } from './feature-review-spec-row.ts'
import { reviewDecision, synthesisSources } from './feature-review-synthesis-sources.ts'
import type { NativeData } from './native-review-driver.ts'
import { finding } from './record-builders.ts'

/** Each native panel reports three distinct causes under the same accepted criterion. */
export function mixedReviewInitialData(task: NativeTask): NativeData {
  if (task.name === 'spec') return { findings: [], specRows: [fixtureSpecRow(task.action)] }
  if (!task.name.startsWith('panel-')) return { findings: [] }
  const spec = task.action.inputs.manifest.spec
  if (spec.kind !== 'accepted' || !spec.effective.spec.criteria[0]) throw new Error('mixed-criterion-missing')
  const target = {
    format: 'omp-build-finding-target/1' as const,
    kind: 'criterion' as const,
    spec: spec.effective.own,
    id: spec.effective.spec.criteria[0].id,
  }
  return {
    findings: [
      finding({ label: 'issue(blocking)', target, description: 'The selected region is not saved.' }),
      finding({ label: 'suggestion', target, description: 'A broad independent save audit is warranted.' }),
      finding({ label: 'suggestion', target, description: 'A nonurgent save-path observation.' }),
    ],
  }
}

/** The synthesis cites real selected panel records, partitioning all original findings. */
export function mixedReviewDecision(task: string): NativeData {
  const base = reviewDecision(task)
  const groups: Array<{ ids: string[]; refs: unknown[]; target: unknown }> = Array.from({ length: 3 }, () => ({
    ids: [],
    refs: [],
    target: null,
  }))
  for (const item of synthesisSources(task)) {
    if (!item || typeof item !== 'object' || !('payload' in item) || !('ref' in item))
      throw new Error('mixed-source-invalid')
    const payload = item.payload
    if (!payload || typeof payload !== 'object' || !('findings' in payload) || !Array.isArray(payload.findings))
      continue
    for (const [index, original] of payload.findings.entries()) {
      const group = groups[index]
      if (
        !group ||
        !original ||
        typeof original !== 'object' ||
        typeof original.id !== 'string' ||
        !original.data?.target
      )
        throw new Error('mixed-finding-invalid')
      group.ids.push(original.id)
      group.refs.push(item.ref)
      group.target = original.data.target
    }
  }
  const names = ['selected-region', 'broad-audit', 'save-observation']
  const findings = groups.map((group, index) => {
    if (!group.ids.length) throw new Error('mixed-finding-source-missing')
    return {
      id: `${names[index]}-finding`,
      label: index === 0 ? 'issue(blocking)' : 'suggestion',
      impactReason: 'The source records describe this distinct save-path issue.',
      state: 'usable',
      target: group.target,
      sourceFindingIds: group.ids,
      mergeReason: 'The panel findings describe the same save-path issue and target.',
      description: names[index],
    }
  })
  const causes = groups.map((group, index) => {
    const refs = [...new Map(group.refs.map((ref) => [canonicalValueDigest(ref), ref])).values()]
    const judgment = (value: boolean) => ({
      state: 'supported',
      value,
      reason: 'The cited panel records establish this bounded judgment.',
      references: refs,
    })
    return {
      id: `${names[index]}-cause`,
      title: names[index],
      mechanism: 'The save path has the reported defect.',
      fix: 'Restore the selected save-path behavior.',
      failure: 'The reported save-path behavior fails.',
      restored: 'The reported behavior is restored.',
      paths: ['src/save.ts'],
      proof: 'Exercise the save path.',
      findingIds: [findings[index]?.id],
      judgment: { necessary: judgment(index !== 2), urgent: judgment(true), tooLarge: judgment(index === 1) },
      proposedDisposition: index === 0 ? 'fix-original' : index === 1 ? 'sister-after' : 'report',
    }
  })
  return { ...base, findings, causes }
}
