import { randomUUID } from 'node:crypto'
import type { ExtensionContext, MessageStartEvent } from '@oh-my-pi/pi-coding-agent'
import { resolveFeatureRevocation } from '../roxabi/feature-continuation-admission.ts'
import type { FramingOperator } from '../roxabi/feature-framing-contract.ts'
import {
  captureOrigin,
  type FramingOrigin,
  sameLocation,
  sameSession,
} from '../roxabi/feature-framing-controller-lease.ts'
import { classifyIssueReference } from '../roxabi/prepare-canonical-checkout.ts'
import type { OmpBuildExtensionApi } from './omp-controller.ts'
import type { FeatureReady } from './omp-feature-admission.ts'
import { rootContext } from './omp-feature-session.ts'

type AgentMessage = MessageStartEvent['message']
type Delivery = Pick<FeatureReady, 'repository' | 'issue'> & { origin: FramingOrigin; operator: FramingOperator }
type Running = { delivery: Delivery; message: AgentMessage; pausing?: true }
type Runs = { pending: Map<string, Delivery>; running?: Running }

// A UW confirmation slot is not a model run. Dispatch can queue behind a different turn, so bind
// pause to the host's actual delivery of this prompt, not to the command or send promise lifetime.
const runs = new WeakMap<OmpBuildExtensionApi, Runs>()
const deliveryMarker = /^delivery: ([a-f0-9-]{36})$/m

export function stageFeatureDelivery(
  pi: OmpBuildExtensionApi,
  ctx: ExtensionContext,
  operator: FramingOperator,
  { repository, issue }: FeatureReady,
) {
  let state = runs.get(pi)
  if (state === undefined) {
    state = { pending: new Map() }
    runs.set(pi, state)
  }
  const id = randomUUID()
  const delivery = { origin: captureOrigin(ctx), operator, repository, issue }
  state.pending.set(id, delivery)
  const own = state
  return {
    id,
    discard() {
      own.pending.delete(id)
      if (own.running?.delivery === delivery) own.running = undefined
    },
  }
}

function inOrigin(delivery: Delivery, ctx: ExtensionContext): boolean {
  return sameSession(delivery.origin, ctx) && sameLocation(delivery.origin, ctx)
}

function activeRun(pi: OmpBuildExtensionApi, ctx: ExtensionContext): Running | undefined {
  const running = runs.get(pi)?.running
  return running !== undefined && !running.pausing && !ctx.isIdle() && inOrigin(running.delivery, ctx)
    ? running
    : undefined
}

async function matchesBoundPull(reference: string, { origin, repository, issue }: Delivery): Promise<boolean> {
  try {
    // Resolve the authenticated binding only; unlike abandonment, pause writes no control records.
    const target = await resolveFeatureRevocation({ cwd: origin.cwd, reference, control: 'abandon', principal: false })
    return (
      !('kind' in target) &&
      target.mandate !== undefined &&
      target.scope.repository === repository &&
      target.scope.target === `${repository}#${issue}`
    )
  } catch {
    return false
  }
}

export async function pauseRunningFeature(
  pi: OmpBuildExtensionApi,
  ctx: ExtensionContext,
  reference: string,
  stop: (operator: FramingOperator) => void,
): Promise<boolean> {
  const running = activeRun(pi, ctx)
  if (running === undefined) return false
  const { repository, issue, operator } = running.delivery
  const parsed = classifyIssueReference(reference)
  if ('reason' in parsed) return false
  if (parsed.repository !== null && parsed.repository.toLowerCase() !== repository.toLowerCase()) return false
  if (parsed.number !== issue) {
    if (!(await matchesBoundPull(reference, running.delivery))) return false
    // The lookup may outlive the prompt, even if a new run has started for the same UW.
    if (activeRun(pi, ctx) !== running) return false
  }
  running.pausing = true
  stop(operator)
  return true
}

/** The scoped host abort may also cancel a stop callback registered on an earlier turn. */
export function featurePausePending(pi: OmpBuildExtensionApi, ctx: ExtensionContext): boolean {
  const running = runs.get(pi)?.running
  return running?.pausing === true && inOrigin(running.delivery, ctx)
}

export function finishFeatureRun(pi: OmpBuildExtensionApi, ctx: ExtensionContext, messages: AgentMessage[]): void {
  const state = runs.get(pi)
  const running = state?.running
  if (
    state !== undefined &&
    running !== undefined &&
    inOrigin(running.delivery, ctx) &&
    messages.includes(running.message)
  ) {
    state.running = undefined
  }
}

export function clearFeatureRuns(pi: OmpBuildExtensionApi): void {
  runs.delete(pi)
}

export function installFeatureRunLifecycle(pi: OmpBuildExtensionApi): void {
  pi.on('agent_start', (_event, ctx) => {
    const state = runs.get(pi)
    if (state !== undefined && rootContext(ctx)) state.running = undefined
  })
  pi.on('message_start', ({ message }, ctx) => {
    const state = runs.get(pi)
    if (state === undefined || !rootContext(ctx) || ctx.isIdle()) return
    if (message.role === 'custom' && message.attribution === 'user') state.running = undefined
    if (message.role !== 'user') return
    // Another user prompt takes ownership of this run. Agent/tool messages do not.
    state.running = undefined
    const content = message.content
    const text = typeof content === 'string' ? content : content.find((part) => part.type === 'text')?.text
    const id = text?.match(deliveryMarker)?.[1]
    if (id === undefined) return
    const delivery = state.pending.get(id)
    if (delivery === undefined || !inOrigin(delivery, ctx)) return
    state.pending.delete(id)
    state.running = { delivery, message }
  })
}
