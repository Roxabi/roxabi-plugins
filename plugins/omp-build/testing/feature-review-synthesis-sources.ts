import { readFileSync } from 'node:fs'
import path from 'node:path'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { recordInputRefSchema } from '../engine/action-input-schema.ts'
import type { NativeData } from './native-review-driver.ts'

type Data = NativeData

/** Read the same index and selected stage files available to the native synthesis task. */
export function synthesisSources(task: string): unknown[] {
  const matches = [...task.matchAll(/^Index: (.+)$/gm)]
  if (matches.length !== 1 || matches[0]?.[1] === undefined) throw new Error('synthesis-index-missing')
  const index = matches[0][1]
  const directory = path.dirname(index)
  const lines = readFileSync(index, 'utf8').split('\n')
  const files = new Set(lines.filter((line) => line.startsWith('- ')).map((line) => line.slice(2)))
  if (!files.has('stage/annex.json')) throw new Error('synthesis-annex-unlisted')
  const annex: unknown = JSON.parse(readFileSync(path.join(directory, 'stage/annex.json'), 'utf8'))
  if (!Array.isArray(annex)) throw new Error('synthesis-annex-invalid')
  return annex.map((item) => {
    const ref = recordInputRefSchema.parse(item)
    if (ref.record.kind !== 'contribution' || ref.selector !== '/payload') throw new Error('synthesis-source-invalid')
    const source = [
      'stage',
      encodeURIComponent(ref.record.scope.repository),
      encodeURIComponent(ref.record.scope.target),
      encodeURIComponent(ref.record.kind),
      encodeURIComponent(ref.record.recordId),
      `${encodeURIComponent(ref.selector)}.json`,
    ].join('/')
    if (!files.has(source)) throw new Error('synthesis-source-unlisted')
    const payload: unknown = JSON.parse(readFileSync(path.join(directory, source), 'utf8'))
    if (canonicalValueDigest(payload) !== ref.digest) throw new Error('synthesis-source-digest-mismatch')
    return { contributionId: ref.record.recordId, payload }
  })
}
type SynthesisSources = {
  sourceContributionIds: string[]
  sourceFindingIds: string[]
  criterionVerdicts: { contributionId: string; target: unknown }[]
}

function collectFindingIds(payload: object, result: SynthesisSources): void {
  if (!('findings' in payload) || !Array.isArray(payload.findings)) return
  for (const item of payload.findings) {
    if (
      item === null ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      !('id' in item) ||
      typeof item.id !== 'string'
    )
      throw new Error('synthesis-finding-invalid')
    result.sourceFindingIds.push(item.id)
  }
}

function collectSourceIds(source: unknown, result: SynthesisSources): void {
  if (
    source === null ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    !('contributionId' in source) ||
    !('payload' in source)
  )
    throw new Error('synthesis-source-invalid')
  const contributionId = source.contributionId
  const payload = source.payload
  if (typeof contributionId !== 'string' || payload === null || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('synthesis-source-invalid')
  result.sourceContributionIds.push(contributionId)
  if (
    'structured' in payload &&
    payload.structured !== null &&
    typeof payload.structured === 'object' &&
    'specRows' in payload.structured &&
    Array.isArray(payload.structured.specRows)
  ) {
    for (const row of payload.structured.specRows) {
      if (row === null || typeof row !== 'object' || !('target' in row)) throw new Error('synthesis-spec-row-invalid')
      result.criterionVerdicts.push({ contributionId, target: row.target })
    }
  }
  collectFindingIds(payload, result)
}

function decodeSynthesisSources(task: string, requireFindings = true): SynthesisSources {
  const sources = synthesisSources(task)
  const result: SynthesisSources = { sourceContributionIds: [], sourceFindingIds: [], criterionVerdicts: [] }
  for (const source of sources) collectSourceIds(source, result)
  if (result.sourceContributionIds.length === 0 || (requireFindings && result.sourceFindingIds.length === 0))
    throw new Error('synthesis-evidence-missing')
  return result
}
export function reviewDecision(task: string): Data {
  const { sourceContributionIds, sourceFindingIds, criterionVerdicts } = decodeSynthesisSources(task)
  return {
    purpose: 'review',
    policy: { version: 'baseline' },
    sourceContributionIds,
    findings: [
      {
        id: 'selected-region-blocker',
        label: 'issue(blocking)',
        impactReason: 'The saved region can be stale.',
        state: 'usable',
        sourceFindingIds,
        description: 'Persist the selected region.',
        mergeReason: 'Both panel reports identify the same stale selected-region persistence defect.',
      },
    ],
    causes: [
      {
        id: 'selected-region-cause',
        title: 'Selected region persistence',
        mechanism: 'The save path retains a stale selected region.',
        fix: 'Persist the current selected region in the save path.',
        failure: 'A save after selecting a region stores the previous region.',
        restored: 'Saving retains the selected region.',
        paths: ['src/save.ts'],
        proof: 'Exercise a save after selecting a region.',
        findingIds: ['selected-region-blocker'],
        authorization: 'required',
      },
    ],
    standards: {
      state: 'observed',
      rows: [{ smell: 'State persistence', assessment: 'The save path must preserve the selected region.' }],
    },
    criterionVerdicts,
    exclusionClaims: [],
  }
}

export function cleanReviewDecision(task: string): Data {
  const { sourceContributionIds, criterionVerdicts } = decodeSynthesisSources(task, false)
  return {
    purpose: 'review',
    policy: { version: 'baseline' },
    sourceContributionIds,
    findings: [],
    causes: [],
    standards: { state: 'ras' },
    criterionVerdicts,
    exclusionClaims: [],
  }
}
