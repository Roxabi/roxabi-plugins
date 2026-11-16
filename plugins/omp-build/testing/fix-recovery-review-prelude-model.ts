import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@oh-my-pi/pi-ai'
import type { MockResponse } from '@oh-my-pi/pi-ai/providers/mock'
import { actionInputDigest } from '../engine/action-input.ts'
import { actionInputManifestSchema } from '../engine/action-input-schema.ts'
import { fixtureSpecRow } from './feature-review-spec-row.ts'
import { cleanReviewDecision, reviewDecision } from './feature-review-synthesis-sources.ts'
import { finding } from './record-builders.ts'

type Mode = 'defect' | 'healthy'
type Role = 'synthesis' | 'spec' | 'recall' | 'panel'
type ProviderCall = { tools: string[]; systemPrompt: unknown; messages: unknown; error?: string }

export function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

export function announcedBatch(value: unknown, used: ReadonlySet<string>): string | undefined {
  for (const text of strings(value)) {
    for (const match of text.matchAll(/OMP_BUILD_NATIVE_BATCH:\s*\n\s*(\{[^\n]+\})/g)) {
      const parsed = JSON.parse(match[1] ?? '{}') as { batchId?: unknown }
      if (typeof parsed.batchId === 'string' && !used.has(parsed.batchId)) return parsed.batchId
    }
  }
}

function assignment(context: Context, names: Set<string>) {
  const text = context.messages
    .flatMap((message) => {
      if (message.role !== 'user') return []
      if (typeof message.content === 'string') return [message.content]
      return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
    })
    .join('\n')
  const indexPath = /^Index: (.+)$/m.exec(text)?.[1]
  if (!indexPath) throw new Error('review-prelude-child-index-unidentified')
  let role: Role = 'panel'
  if (text.includes('Synthesize only the dossier named by the index.')) role = 'synthesis'
  else if (text.includes('Judge each accepted criterion in the index.')) role = 'spec'
  else if (!names.has('bash')) role = 'recall'
  return { indexPath, role }
}

function probe(role: Role, indexPath: string, mode: Mode): MockResponse {
  if (role === 'synthesis' || role === 'recall')
    return { content: [{ type: 'toolCall', id: 'prelude-probe', name: 'read', arguments: { path: indexPath } }] }
  const command =
    mode === 'healthy'
      ? `bun run test && bun -e 'import { save } from "./src/save.ts"; console.log("REGION_PROBE=" + save("eu-west"))'`
      : `bun -e 'import { save } from "./src/save.ts"; console.log("REGION_PROBE=" + save("eu-west"))'`
  return { content: [{ type: 'toolCall', id: 'prelude-probe', name: 'bash', arguments: { command } }] }
}

function specAndFinding(indexPath: string) {
  const manifest = actionInputManifestSchema.parse(
    JSON.parse(readFileSync(join(dirname(indexPath), 'manifest.json'), 'utf8')),
  )
  const spec = manifest.spec
  if (spec.kind !== 'accepted') throw new Error('review-prelude-spec-not-accepted')
  const criterion = spec.effective.spec.criteria[0]
  if (!criterion) throw new Error('review-prelude-criterion-missing')
  const target = {
    format: 'omp-build-finding-target/1' as const,
    kind: 'criterion' as const,
    spec: spec.effective.own,
    id: criterion.id,
  }
  const fingerprint = actionInputDigest(manifest)
  const action = { inputs: { fingerprint }, snapshot: { indexPath, manifestDigest: fingerprint } }
  return { target, action }
}

function childData(role: Role, indexPath: string, mode: Mode) {
  const { target, action } = specAndFinding(indexPath)
  const taskText = `Index: ${indexPath}`
  if (role === 'synthesis') return mode === 'healthy' ? cleanReviewDecision(taskText) : reviewDecision(taskText)
  if (role === 'spec') {
    const row =
      mode === 'healthy'
        ? fixtureSpecRow(action)
        : {
            target,
            verdict: 'missing',
            criterionKind: 'behavior',
            bugRegression: false,
            restoration: 'not-applicable',
            examined: [],
            reason: 'Executing save with eu-west returns us-east, so the selected region is not preserved.',
          }
    return { findings: [], specRows: [row] }
  }
  if (mode === 'healthy' || role === 'recall') return { findings: [] }
  return {
    findings: [
      finding({
        label: 'issue(blocking)',
        target,
        description: 'Saving discards the selected region.',
        location: { file: 'src/save.ts', line: 2 },
        rootCause: 'The save path returns a fixed stale region.',
        symptomsEvidence: 'Executing save("eu-west") returns us-east.',
      }),
    ],
  }
}

function childResponse(context: Context, names: Set<string>, mode: Mode, probes: string[]): MockResponse {
  const { indexPath, role } = assignment(context, names)
  const messages = JSON.stringify(context.messages)
  if (!messages.includes('prelude-probe')) return probe(role, indexPath, mode)
  const expected = mode === 'healthy' ? 'REGION_PROBE=eu-west' : 'REGION_PROBE=us-east'
  if (role !== 'synthesis' && role !== 'recall' && !messages.includes(expected))
    throw new Error(`review-prelude-probe-failed:${role}`)
  probes.push(role)
  return {
    content: [
      { type: 'toolCall', id: 'prelude-yield', name: 'yield', arguments: { data: childData(role, indexPath, mode) } },
    ],
  }
}

function dispatchBatch(context: Context, dispatched: Set<string>): MockResponse | undefined {
  const batchId = announcedBatch(context.messages, dispatched)
  if (!batchId) return undefined
  dispatched.add(batchId)
  return {
    content: [
      {
        type: 'toolCall',
        id: `review-batch-${dispatched.size}`,
        name: 'omp_build_execute_native_batch',
        arguments: { batchId },
      },
    ],
  }
}

export function createPreludeModel(mode: Mode) {
  const probes: string[] = []
  const calls: ProviderCall[] = []
  const dispatched = new Set<string>()
  let startCalled = false
  let phase: 'start' | 'batch' = 'start'
  const handler = (context: Context): MockResponse => {
    const names = new Set((context.tools ?? []).map((tool) => tool.name))
    const call: ProviderCall = {
      tools: [...names],
      systemPrompt: context.systemPrompt,
      messages: structuredClone(context.messages),
    }
    calls.push(call)
    try {
      if (names.has('yield')) return childResponse(context, names, mode, probes)
      if (phase === 'start') {
        phase = 'batch'
        startCalled = true
        return {
          content: [{ type: 'toolCall', id: 'review-start', name: 'omp_build_start_review', arguments: { pr: 7 } }],
        }
      }
      const batch = startCalled ? dispatchBatch(context, dispatched) : undefined
      if (batch) return batch
      return { content: ['Sandbox operator event completed.'] }
    } catch (error) {
      call.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
      throw error
    }
  }
  return {
    handler,
    probes,
    calls,
    dispatched,
    started: () => startCalled,
    batchPhase: () => {
      phase = 'batch'
    },
  }
}
