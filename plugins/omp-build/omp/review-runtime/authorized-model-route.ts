import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'

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
