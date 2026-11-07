import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { type FramingProcedures, verifyFramingProcedures } from './feature-framing-procedures.ts'
import type { FramingEffectGuard } from './uw-framing-contract.ts'

/** Host-only, revocable guard bound to the original operation and the live session location. */
export function createFramingEffectGuard(input: {
  ctx: ExtensionContext
  procedures: FramingProcedures
  operationId: string
  proposalDigest: string
  isCurrent(): boolean
}): { guard: FramingEffectGuard; revoke(): void } {
  const { ctx } = input
  const session = ctx.sessionManager.getSessionId()
  const agent = ctx.agent.id
  const cwd = ctx.cwd
  const sessionFile = ctx.sessionManager.getSessionFile()
  const artifactDirectory = ctx.sessionManager.getArtifactsDir()
  let live = true
  const current = (): boolean =>
    live &&
    input.isCurrent() &&
    ctx.agent.kind === 'main' &&
    ctx.agent.depth === 0 &&
    ctx.agent.id === agent &&
    ctx.sessionManager.getSessionId() === session &&
    ctx.cwd === cwd &&
    ctx.sessionManager.getCwd() === cwd &&
    ctx.sessionManager.getSessionFile() === sessionFile &&
    ctx.sessionManager.getArtifactsDir() === artifactDirectory
  const fail = (): never => {
    live = false
    ctx.abort()
    throw new Error('framing-effect-guard-revoked')
  }
  return {
    revoke() {
      live = false
    },
    guard: {
      async check(point) {
        if (!current() || point.operationId !== input.operationId || point.proposalDigest !== input.proposalDigest)
          fail()
        const verified = await verifyFramingProcedures(input.procedures)
        if (
          !verified.ok ||
          !current() ||
          point.operationId !== input.operationId ||
          point.proposalDigest !== input.proposalDigest
        )
          fail()
      },
    },
  }
}
