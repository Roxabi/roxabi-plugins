import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { AgentRegistry } from '@oh-my-pi/pi-coding-agent/registry/agent-registry'
import type { AgentSession } from '@oh-my-pi/pi-coding-agent/session/agent-session'
import type { NativeBatch } from './contracts'
import type { NativeBatchController } from './controller'

type Surface = { enabled: string[]; mounted: string[]; active: string[] }
type Request = { batch: NativeBatch; revoked: boolean }
type CapturedRoot = {
  root: AgentSession
  current: (allowTransition: boolean) => boolean
  registry: AgentRegistry
}
type Lease = {
  batch: NativeBatch
  request: Request
  root: AgentSession
  current: (allowTransition: boolean) => boolean
  before: Surface
  applied: Surface
  drifted: boolean
  unsubscribe: () => void
}
const leases = new WeakMap<NativeBatchController, Lease>()
const tails = new WeakMap<NativeBatchController, Promise<void>>()
const pending = new WeakMap<NativeBatchController, Request>()
const ownedTool = 'omp_build_execute_native_batch'

function surface(root: AgentSession): Surface {
  return {
    enabled: root.getEnabledToolNames(),
    mounted: root.getMountedXdevToolNames(),
    active: root.getActiveToolNames(),
  }
}
function same(a: Surface, b: Surface): boolean {
  const equal = (x: string[], y: string[]) => x.length === y.length && x.every((name) => y.includes(name))
  return equal(a.enabled, b.enabled) && equal(a.mounted, b.mounted) && equal(a.active, b.active)
}
function serialize<T>(controller: NativeBatchController, operation: () => Promise<T>): Promise<T> {
  const result = (tails.get(controller) ?? Promise.resolve()).catch(() => {}).then(operation)
  tails.set(
    controller,
    result.then(
      () => {},
      () => {},
    ),
  )
  return result
}
async function capture(ctx: ExtensionContext): Promise<CapturedRoot> {
  if (ctx.agent.kind !== 'main' || ctx.agent.depth !== 0) throw new Error('native task mask root unavailable')
  const registry = AgentRegistry.global()
  const ref = registry.get(ctx.agent.id)
  const root = ref?.session
  if (!ref || !root || ref.kind !== 'main' || root.modelRegistry !== ctx.modelRegistry)
    throw new Error('native task mask root unavailable')
  const modelRegistry = ctx.modelRegistry
  const registrySessionFile = ref.sessionFile
  const costGate = root.costGate
  const journal = ctx.sessionManager.getSessionId()
  const file = ctx.sessionManager.getSessionFile()
  const cwd = ctx.cwd
  const provider = root.agent.sessionId
  const current = (allowTransition: boolean) =>
    registry.get(ctx.agent.id) === ref &&
    ref.session === root &&
    !root.isDisposed &&
    (allowTransition || !root.isSessionTransitioning) &&
    ctx.modelRegistry === modelRegistry &&
    root.modelRegistry === modelRegistry &&
    ctx.sessionManager.getSessionId() === journal &&
    root.sessionManager.getSessionId() === journal &&
    ctx.sessionManager.getSessionFile() === file &&
    root.sessionManager.getSessionFile() === file &&
    ref.sessionFile === registrySessionFile &&
    ctx.cwd === cwd &&
    root.sessionManager.getCwd() === cwd &&
    root.agent.sessionId === provider &&
    root.costGate === costGate
  if (!current(false)) throw new Error('native task mask root changed')
  return { root, current, registry }
}

function watchLease(controller: NativeBatchController, lease: Lease, registry: AgentRegistry): void {
  const revoke = () => {
    if (leases.get(controller) !== lease) return
    lease.drifted = true
    controller.status('native task mask root changed; stopping owned batch')
    void controller.stopOwned(lease.batch, 'native-task-mask-root-changed').catch((error) => {
      controller.status(`native task mask stop failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  const unsubscribeRegistry = registry.onChange(() => {
    if (!lease.current(true)) revoke()
  })
  const unsubscribeSession = lease.root.registerSessionChangeCallback(revoke)
  lease.unsubscribe = () => {
    unsubscribeRegistry()
    unsubscribeSession()
  }
}

async function applyTaskMask(
  controller: NativeBatchController,
  batch: NativeBatch,
  request: Request,
  captured: CapturedRoot,
): Promise<void> {
  const { root, current, registry } = captured
  if (request.revoked || !current(false) || controller.active() !== batch)
    throw new Error('native task mask batch changed')
  const before = surface(root)
  if (!before.enabled.includes(ownedTool) || !before.active.includes(ownedTool) || before.mounted.includes(ownedTool))
    throw new Error('native dispatch tool is not enabled at top level')
  if (before.enabled.includes('task') && !root.hasBuiltInTool('task'))
    throw new Error('native task mask cannot identify builtin task')
  const enabled = before.enabled.filter((name) => name !== 'task')
  const mounted = before.mounted.filter((name) => name !== 'task')
  if (before.enabled.includes('task') || before.mounted.includes('task'))
    await root.setActiveToolPresentation(enabled, mounted)
  const applied = surface(root)
  const expected: Surface = { enabled, mounted, active: before.active.filter((name) => name !== 'task') }
  const lease: Lease = { batch, request, root, current, before, applied, drifted: false, unsubscribe: () => {} }
  leases.set(controller, lease)
  watchLease(controller, lease, registry)
  if (request.revoked || !current(false) || controller.active() !== batch || !same(applied, expected))
    throw new Error('native task mask application drifted')
}

/** Acquire only for an actual hidden control send, preserving the session's exact existing presentation. */
export function acquireTaskMask(controller: NativeBatchController, batch: NativeBatch): Promise<void> {
  const request = { batch, revoked: false }
  pending.set(controller, request)
  return serialize(controller, async () => {
    if (leases.has(controller)) throw new Error('native task mask lease already active')
    const ctx = controller.rootContext()
    if (!ctx || request.revoked || controller.active() !== batch) throw new Error('native task mask batch unavailable')
    const captured = await capture(ctx)
    await captured.root.runToolRegistryMutation(() => applyTaskMask(controller, batch, request, captured))
    controller.status('native task mask active')
  }).finally(() => {
    if (pending.get(controller) === request) pending.delete(controller)
  })
}
/** Detect observable drift without reapplying the mask. */
export async function taskMaskCurrent(controller: NativeBatchController, batch: NativeBatch): Promise<boolean> {
  const lease = leases.get(controller)
  if (!lease || lease.batch !== batch) return false
  try {
    return await lease.root.runToolRegistryMutation(async () => {
      if (leases.get(controller) !== lease || !lease.current(false) || !same(surface(lease.root), lease.applied)) {
        lease.drifted = true
        return false
      }
      return true
    })
  } catch (error) {
    lease.drifted = true
    throw error
  }
}

export function taskMaskOwnsActiveBatch(controller: NativeBatchController): boolean {
  const lease = leases.get(controller)
  return !!lease && lease.batch === controller.active()
}

/** Restore only if the same root and the applied surface still belong to this lease. */
export function releaseTaskMask(
  controller: NativeBatchController,
  allowTransition = false,
  batch?: NativeBatch,
): Promise<void> {
  const request = pending.get(controller)
  if (request && (!batch || request.batch === batch)) request.revoked = true
  const token = leases.get(controller)
  return serialize(controller, async () => {
    const lease = leases.get(controller)
    if (!lease || (batch && lease.batch !== batch) || (token ? lease !== token : !request || lease.request !== request))
      return
    leases.delete(controller)
    lease.unsubscribe()
    await lease.root.runToolRegistryMutation(async () => {
      if (lease.drifted || !lease.current(allowTransition) || !same(surface(lease.root), lease.applied))
        throw new Error('native task mask restoration refused: root or tool surface drifted; task may remain disabled')
      if (!same(lease.before, lease.applied))
        await lease.root.setActiveToolPresentation(lease.before.enabled, lease.before.mounted)
      if (!lease.current(allowTransition) || !same(surface(lease.root), lease.before))
        throw new Error('native task mask restoration drifted')
    })
    controller.status('native task mask restored')
  })
}
