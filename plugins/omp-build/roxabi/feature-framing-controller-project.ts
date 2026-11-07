import { randomBytes } from 'node:crypto'
import type { ContextEvent, ContextEventResult, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { projectFramingContext } from '../omp/omp-feature-framing-context.ts'
import { retainIndex } from './feature-framing-controller-index.ts'
import {
  blockLease,
  type ControllerCore,
  currentStage,
  type LeaseState,
  live,
  maybeFinalize,
  revokeLease,
  sameLocation,
  sameSession,
} from './feature-framing-controller-lease.ts'

type ProjectionAttempt = { settled: true; value: ContextEventResult | undefined } | { settled: false }
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
export async function projectFraming(
  core: ControllerCore,
  event: ContextEvent,
  ctx: ExtensionContext,
): Promise<ContextEventResult | undefined> {
  /** A projection belongs only to the live root interview of the same session; a moved session revokes. */
  function projectionLease(ctx: ExtensionContext): LeaseState | null {
    const lease = core.current
    if (lease === null || !live(core, lease) || !sameSession(lease.origin, ctx)) return null
    if (lease.phase.kind !== 'interview' && lease.phase.kind !== 'proposal-ready') return null
    if (sameLocation(lease.origin, ctx)) return lease
    revokeLease(core, lease, 'framing-location-changed')
    ctx.abort()
    return null
  }

  function indexedReference(lease: LeaseState, ctx: ExtensionContext): string | undefined {
    try {
      retainIndex(lease, ctx, true)
    } catch (error) {
      blockLease(core, lease, 'framing-index-unavailable', ctx, `feature-framing blocked: ${errorText(error)}`)
      return undefined
    }
    return lease.index?.reference
  }

  /** One fresh token and projection; unsettled only when the lease moved on during the await. */
  async function projectAttempt(
    lease: LeaseState,
    ctx: ExtensionContext,
    event: ContextEvent,
    procedures: NonNullable<LeaseState['procedures']>,
    indexRef: string,
  ): Promise<ProjectionAttempt> {
    const revision = lease.revision
    const stage = currentStage(lease)
    const token = Object.freeze({ value: randomBytes(24).toString('base64url'), revision, stage })
    lease.token = token
    const projected = await projectFramingContext({
      event,
      procedures,
      stage,
      supplyToken: token.value,
      indexRef: lease.index?.reference ?? indexRef,
    })
    if (!live(core, lease)) return { settled: true, value: undefined }
    if (!sameSession(lease.origin, ctx) || !sameLocation(lease.origin, ctx)) {
      revokeLease(core, lease, 'framing-location-changed')
      ctx.abort()
      return { settled: true, value: undefined }
    }
    if (!projected.ok) {
      blockLease(
        core,
        lease,
        'framing-supply-changed',
        ctx,
        `feature-framing blocked: framing supply changed (${projected.diagnostics.map((item) => item.code).join(', ')})`,
      )
      return { settled: true, value: undefined }
    }
    const current =
      lease.revision === revision &&
      lease.token === token &&
      (lease.phase.kind === 'interview' || lease.phase.kind === 'proposal-ready')
    return current ? { settled: true, value: projected.value } : { settled: false }
  }

  async function project(event: ContextEvent, ctx: ExtensionContext): Promise<ContextEventResult | undefined> {
    const lease = projectionLease(ctx)
    const procedures = lease?.procedures ?? null
    if (lease === null || procedures === null) return undefined
    const indexRef = indexedReference(lease, ctx)
    if (indexRef === undefined) return undefined
    lease.inflight += 1
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const attempted = await projectAttempt(lease, ctx, event, procedures, indexRef)
        if (attempted.settled) return attempted.value
      }
      lease.token = null
      ctx.abort()
      return undefined
    } finally {
      lease.inflight -= 1
      maybeFinalize(core, lease)
    }
  }
  return project(event, ctx)
}
