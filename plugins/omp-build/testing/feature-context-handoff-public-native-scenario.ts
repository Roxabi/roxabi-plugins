import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { MockResponse } from '@oh-my-pi/pi-ai/providers/mock'
import type { Context } from '@oh-my-pi/pi-ai/types'
import { actionInputManifestSchema } from '../engine/action-input-schema.ts'
import type { PlanOutput, PlanReview } from '../engine/workflow-output-schema.ts'
import { outsideEffectImplementResponse } from './context-external-effect-child.ts'

export type NativePhase = 'implement' | 'plan' | 'plan-review'
export type NativeTerminal = { toolCallId: string; isError: boolean; result: unknown }

export type PublicNativeScenario = {
  handler: (context: Context) => MockResponse
  observeStart: (toolCallId: string) => void
  observeEnd: (toolCallId: string, isError: boolean, result: unknown) => void
  dispatches: string[]
  phaseByDispatch: Map<string, NativePhase>
  waitNativeEnd: (id: string) => Promise<{ isError: boolean; result: unknown }>
  waitPlanReview: () => Promise<[NativeTerminal, NativeTerminal]>
}

function userText(context: Context): string {
  return context.messages
    .flatMap((message) =>
      message.role === 'user'
        ? typeof message.content === 'string'
          ? [message.content]
          : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : [],
    )
    .join('\n')
}

function batchIdFromNativeMarker(json: string): string | undefined {
  try {
    const value: unknown = JSON.parse(json)
    if (value && typeof value === 'object' && 'batchId' in value && typeof value.batchId === 'string')
      return value.batchId
  } catch {
    /* A partial stream is not an announcement. */
  }
  return undefined
}

/** Newest valid host OMP_BUILD_NATIVE_BATCH marker on developer text (custom→LLM surface). */
function latestAuthorizedBatch(context: Context): string | undefined {
  let latest: string | undefined
  for (const message of context.messages) {
    if (message.role !== 'developer') continue
    const texts =
      typeof message.content === 'string'
        ? [message.content]
        : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
    for (const text of texts) {
      for (const match of text.matchAll(/OMP_BUILD_NATIVE_BATCH:\s*(\{[^\n]+\})/g)) {
        const batchId = batchIdFromNativeMarker(match[1] ?? '{}')
        if (batchId !== undefined) latest = batchId
      }
    }
  }
  return latest
}

function planningResponse(purpose: 'plan' | 'plan-review'): MockResponse {
  const data: PlanOutput | PlanReview =
    purpose === 'plan'
      ? {
          steps: [
            {
              id: 'preserve-region',
              criterionIds: ['C1'],
              change: 'Preserve the selected region and timezone',
              doneWhen: 'The region and timezone are preserved',
              evidence: 'An executable check verifies the saved region',
              paths: ['README.md'],
            },
          ],
          resolutions: [],
        }
      : { outcome: 'clear', blockers: [] }
  return {
    content: [{ type: 'toolCall', name: 'yield', arguments: { data } }],
  }
}

/** Synthetic model scenario + observed native-call correlation for the public-native worker. */
export function createPublicNativeScenario(outsidePath: string): PublicNativeScenario {
  const dispatches: string[] = []
  const seenBatchIds = new Set<string>()
  const phaseByDispatch = new Map<string, NativePhase>()
  const planTerminal = Promise.withResolvers<NativeTerminal>()
  const reviewTerminal = Promise.withResolvers<NativeTerminal>()
  let activeNativeCall: string | null = null
  let reviewEnded = false
  const nativeEnds = new Map<string, { isError: boolean; result: unknown }>()
  const nativeEndWaiters = new Map<string, Array<(value: { isError: boolean; result: unknown }) => void>>()

  function childPurpose(context: Context): NativePhase {
    const index = /^Index: (.+)$/m.exec(userText(context))?.[1]
    assert(index, 'public-native-child-index-missing')
    const manifest = actionInputManifestSchema.parse(
      JSON.parse(readFileSync(join(dirname(index), 'manifest.json'), 'utf8')),
    )
    const purpose = manifest.purpose
    assert(purpose === 'implement' || purpose === 'plan' || purpose === 'plan-review')
    assert(activeNativeCall !== null, 'public-native-child-without-root-invocation')
    const prior = phaseByDispatch.get(activeNativeCall)
    assert(prior === undefined || prior === purpose, 'public-native-mixed-purpose-invocation')
    phaseByDispatch.set(activeNativeCall, purpose)
    return purpose
  }

  /** Schema-bound synthetic MODEL responses for plan / plan-review / implement children. */
  function handler(context: Context): MockResponse {
    if ((context.tools ?? []).some((tool) => tool.name === 'yield')) {
      const purpose = childPurpose(context)
      return purpose === 'implement' ? outsideEffectImplementResponse(context, outsidePath) : planningResponse(purpose)
    }
    // Stop scripting new work after the target review; no later implementation is part of this proof.
    if (reviewEnded) return { content: ['Sandbox plan review observed.'] }
    const latestAnnounced = latestAuthorizedBatch(context)
    if (latestAnnounced !== undefined && !seenBatchIds.has(latestAnnounced)) {
      seenBatchIds.add(latestAnnounced)
      const id = `public-native-${dispatches.length}`
      dispatches.push(id)
      return {
        content: [
          {
            type: 'toolCall',
            id,
            name: 'omp_build_execute_native_batch',
            arguments: { batchId: latestAnnounced },
          },
        ],
      }
    }
    return { content: ['Sandbox operator event completed.'] }
  }

  function observeStart(toolCallId: string): void {
    activeNativeCall = toolCallId
  }

  function observeEnd(toolCallId: string, isError: boolean, result: unknown): void {
    const value = { isError, result }
    nativeEnds.set(toolCallId, value)
    for (const resolve of nativeEndWaiters.get(toolCallId) ?? []) resolve(value)
    nativeEndWaiters.delete(toolCallId)
    const phase = phaseByDispatch.get(toolCallId)
    const terminal = { toolCallId, ...value }
    if (phase === 'plan') planTerminal.resolve(terminal)
    if (phase === 'plan-review') {
      reviewEnded = true
      reviewTerminal.resolve(terminal)
    }
    if (activeNativeCall === toolCallId) activeNativeCall = null
  }

  function waitNativeEnd(toolCallId: string) {
    const done = nativeEnds.get(toolCallId)
    if (done !== undefined) return Promise.resolve(done)
    return new Promise<{ isError: boolean; result: unknown }>((resolve) => {
      const waiters = nativeEndWaiters.get(toolCallId) ?? []
      waiters.push(resolve)
      nativeEndWaiters.set(toolCallId, waiters)
    })
  }

  function waitPlanReview(): Promise<[NativeTerminal, NativeTerminal]> {
    return Promise.all([planTerminal.promise, reviewTerminal.promise]) as Promise<[NativeTerminal, NativeTerminal]>
  }

  return {
    handler,
    observeStart,
    observeEnd,
    dispatches,
    phaseByDispatch,
    waitNativeEnd,
    waitPlanReview,
  }
}
