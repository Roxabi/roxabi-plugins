import type {
  ContextEffectIntent,
  ContextEffectNamespace,
  ContextLocalFileObservation,
} from '../engine/context-effect-review-schema.ts'
import {
  closeDirectoryPins,
  type DirectoryPin,
  observationFlags,
  type ParsedAbsolutePath,
  parseNamedAbsolutePath,
} from './context-local-file-path.ts'
import { type PathBaseline, sampleNamedResource } from './context-local-file-sample.ts'

export type ContextLocalFileObserver = {
  readonly namespace: ContextEffectNamespace
  observe(
    resources: ContextEffectIntent['resources'],
  ): Promise<{ ok: true; value: ContextLocalFileObservation[] } | { ok: false; reason: string }>
  dispose(): Promise<void>
}

type ParsedResource = { resource: ContextEffectIntent['resources'][number]; parsed: ParsedAbsolutePath }
type ObservationResult = Awaited<ReturnType<ContextLocalFileObserver['observe']>>

function parseResource(resource: ContextEffectIntent['resources'][number]): ParsedResource | { reason: string } {
  if (resource === null || typeof resource !== 'object') return { reason: 'resource-malformed' }
  if (typeof resource.key !== 'string' || resource.key.length === 0) return { reason: 'resource-key-malformed' }
  if (typeof resource.absolutePath !== 'string') return { reason: 'path-malformed' }
  const parsed = parseNamedAbsolutePath(resource.absolutePath)
  return 'reason' in parsed ? parsed : { resource, parsed }
}

function parseResources(resources: ContextEffectIntent['resources']): { value: ParsedResource[] } | { reason: string } {
  if (!Array.isArray(resources)) return { reason: 'resources-malformed' }
  if (resources.length > 0 && observationFlags === null) return { reason: 'file-observation-capability-unavailable' }
  const keys = new Set<string>()
  const paths = new Set<string>()
  const value: ParsedResource[] = []
  for (const resource of resources) {
    const parsed = parseResource(resource)
    if ('reason' in parsed) return parsed
    if (keys.has(resource.key)) return { reason: 'resource-key-duplicate' }
    if (paths.has(resource.absolutePath)) return { reason: 'resource-path-duplicate' }
    keys.add(resource.key)
    paths.add(resource.absolutePath)
    value.push(parsed)
  }
  return { value }
}

/**
 * Host-owned descriptor-consistent race-detecting sampler for named local files.
 * Namespace must come from a genuine host factory; not user JSON.
 * Not an atomic transaction or filesystem isolation certificate.
 */
export function createContextLocalFileObserver(
  namespace: ContextEffectNamespace,
  current: () => boolean,
): ContextLocalFileObserver {
  if (namespace.kind !== 'confirmation-local-observer') {
    throw new Error('context-local-file-observer: namespace kind must be confirmation-local-observer')
  }
  const retained = new Map<string, DirectoryPin>()
  const baselines = new Map<string, PathBaseline>()
  const buffer = Buffer.alloc(64 * 1024)
  let disposed = false
  let observing = false
  const inactiveReason = (): string | null => {
    if (disposed) return 'observer-disposed'
    return current() ? null : 'owner-inactive'
  }
  const invalidate = () => {
    disposed = true
    closeDirectoryPins(retained.values())
    retained.clear()
    baselines.clear()
  }
  const sampleResources = (resources: ParsedResource[]): ObservationResult => {
    const values: ContextLocalFileObservation[] = []
    for (const item of resources) {
      const inactive = inactiveReason()
      if (inactive !== null) return { ok: false, reason: inactive }
      const sampled = sampleNamedResource({
        resource: item.resource,
        parsed: item.parsed,
        namespaceId: namespace.id,
        retained,
        baselines,
        buffer,
      })
      if ('reason' in sampled) return { ok: false, reason: sampled.reason }
      values.push(sampled)
    }
    const inactive = inactiveReason()
    return inactive === null ? { ok: true, value: values } : { ok: false, reason: inactive }
  }

  const observationFailure = (error: unknown): ObservationResult => {
    const message = error instanceof Error ? error.message : 'error'
    return { ok: false, reason: `observation-failed:${message}` }
  }

  return {
    namespace,
    async observe(resources) {
      if (disposed) return { ok: false, reason: 'observer-disposed' }
      if (observing) return { ok: false, reason: 'observer-busy' }
      observing = true
      let succeeded = false
      try {
        const inactive = inactiveReason()
        if (inactive !== null) return { ok: false, reason: inactive }
        const parsed = parseResources(resources)
        if ('reason' in parsed) return { ok: false, reason: parsed.reason }
        const result = sampleResources(parsed.value)
        succeeded = result.ok
        return result
      } catch (error) {
        return observationFailure(error)
      } finally {
        observing = false
        if (!succeeded) invalidate()
      }
    },
    async dispose() {
      if (disposed) return
      invalidate()
    },
  }
}
