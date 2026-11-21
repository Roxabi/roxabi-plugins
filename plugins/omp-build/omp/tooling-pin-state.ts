import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { Gh } from '../adapters/github/types.ts'
import { type FramingOrigin, sameSession } from '../roxabi/feature-framing-controller-lease.ts'
import type { TrustedHostPluginPin } from '../roxabi/uw-action-contract.ts'

type Activation = Readonly<{
  pin: TrustedHostPluginPin
  origin: FramingOrigin
  commonDir: string
  targetRepository: string
  originUrl: string
}>
type State = { generation: number; activation?: Activation }
const owners = new WeakMap<object, State>()

function state(owner: object): State {
  let value = owners.get(owner)
  if (value === undefined) {
    value = { generation: 0 }
    owners.set(owner, value)
  }
  return value
}

export function activationGeneration(owner: object): number {
  return state(owner).generation
}

export function hasActivation(owner: object): boolean {
  return state(owner).activation !== undefined
}

export function invalidatePendingActivation(owner: object): void {
  state(owner).generation += 1
}

export function invalidateActivation(owner: object): void {
  const current = state(owner)
  current.generation += 1
  delete current.activation
}

export function gitScope(cwd: string): { commonDir: string; originUrl: string } | undefined {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim()
    const originUrl = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd, encoding: 'utf8' }).trim()
    if (!common || !originUrl) return undefined
    return { commonDir: realpathSync(resolve(cwd, common)), originUrl }
  } catch {
    return undefined
  }
}

export async function canonicalRepository(gh: Gh, cwd: string): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner']))
    if (value && typeof value === 'object' && 'nameWithOwner' in value && typeof value.nameWithOwner === 'string') {
      return value.nameWithOwner
    }
  } catch {}
  return undefined
}

function localMatch(activation: Activation, ctx: ExtensionContext): boolean {
  const scope = gitScope(ctx.cwd)
  return (
    sameSession(activation.origin, ctx) &&
    ctx.sessionManager.getCwd() === ctx.cwd &&
    scope?.commonDir === activation.commonDir &&
    scope.originUrl === activation.originUrl
  )
}

export function bindActivation(owner: object, ctx: ExtensionContext, generation: number, next: Activation): boolean {
  const current = state(owner)
  if (current.generation !== generation || current.activation !== undefined || !localMatch(next, ctx)) return false
  current.activation = Object.freeze({ ...next, pin: Object.freeze({ ...next.pin }) })
  return true
}

export async function activePin(
  owner: object,
  ctx: ExtensionContext,
  gh: Gh,
): Promise<TrustedHostPluginPin | undefined> {
  const current = state(owner)
  const activation = current.activation
  if (activation === undefined || !localMatch(activation, ctx)) return undefined
  const generation = current.generation
  const repository = await canonicalRepository(gh, ctx.cwd)
  if (
    repository !== activation.targetRepository ||
    repository === activation.pin.repository ||
    current.generation !== generation ||
    current.activation !== activation ||
    !localMatch(activation, ctx)
  )
    return undefined
  return activation.pin
}
