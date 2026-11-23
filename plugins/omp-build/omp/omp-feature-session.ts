import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'

export function rootContext(ctx: ExtensionContext): boolean {
  return ctx.agent.kind === 'main' && ctx.agent.depth === 0
}
