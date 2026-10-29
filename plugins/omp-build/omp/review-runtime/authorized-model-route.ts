import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import * as hostSdk from '@oh-my-pi/pi-coding-agent'
import type { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { cfgTaskAgentModelOverrides } from '@oh-my-pi/pi-coding-agent/task/settings'
import { nativeFeatureProfiles } from '../../roxabi/native-feature-profiles.ts'
import { nativeReviewProfiles } from '../../roxabi/native-review-profiles.ts'
import { object } from './capture.ts'
import type { NativeTask } from './contracts.ts'

type ScopedSettingsHost = {
  SettingsManager?: { create(cwd?: string): Settings }
}

/** Read the SDK's active root-session settings inside the actual root hook. */
export function authorizedModelRoute(ctx: ExtensionContext, task: NativeTask): { provider: string; id: string } | null {
  const profile = [...nativeFeatureProfiles, ...nativeReviewProfiles].find((item) => item.name === task.agent)
  const manager = (hostSdk as unknown as ScopedSettingsHost).SettingsManager
  if (!profile || !manager || typeof manager.create !== 'function') return null
  try {
    const overrides = cfgTaskAgentModelOverrides.get(manager.create(ctx.cwd))
    if (!object(overrides)) return null
    const override = overrides[task.agent.trim()]
    if (
      override !== undefined &&
      typeof override !== 'string' &&
      (!Array.isArray(override) || override.some((item) => typeof item !== 'string'))
    )
      return null
    const selectors = (Array.isArray(override) ? override : typeof override === 'string' ? [override] : [])
      .flatMap((item) => item.split(','))
      .map((item) => item.trim())
      .filter(Boolean)
    const model = ctx.models.resolve(selectors.length > 0 ? selectors.join(',') : profile.model)
    return model ? { provider: model.provider, id: model.id } : null
  } catch {
    return null
  }
}

export function matchesAuthorizedModel(ctx: ExtensionContext, expected: { provider: string; id: string }): boolean {
  const current = ctx.models.current()
  return (
    ctx.model !== undefined &&
    current !== undefined &&
    ctx.model.provider === expected.provider &&
    ctx.model.id === expected.id &&
    current.provider === expected.provider &&
    current.id === expected.id
  )
}
