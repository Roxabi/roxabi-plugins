import {
  type CommandRun,
  CRITERION_EVIDENCE_FORMAT,
  commandOutputSchema,
  commandRunSchema,
  criterionEvidenceSchema,
  type EvidenceProvenance,
  executionVersionClaimSchema,
} from './criterion-evidence-schema.ts'

export type ObservationChild = {
  commandRuns?: readonly CommandRun[]
  nativeProvenance?: EvidenceProvenance
  observationProvenance?: EvidenceProvenance
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function completeCriterionDeclarations(value: unknown, child: ObservationChild): unknown {
  return Array.isArray(value)
    ? value.map((item) =>
        completeDeclaration(item, child.commandRuns ?? [], child.nativeProvenance, child.observationProvenance),
      )
    : value
}
function completeDeclaration(
  value: unknown,
  runs: readonly CommandRun[],
  provenance: EvidenceProvenance | undefined,
  observationProvenance: EvidenceProvenance | undefined,
): unknown {
  if (!isRecord(value)) return value
  if (value.verification === 'unverified') {
    return {
      target: value.target,
      verification: 'unverified',
      reason: typeof value.reason === 'string' && value.reason.length > 0 ? value.reason : 'unverified',
    }
  }
  if (value.verification !== 'evidence' || !Array.isArray(value.evidence)) return value

  const evidence = []
  for (const item of value.evidence) {
    const filled = completeObservation(item, runs, provenance, observationProvenance)
    if ('unverified' in filled) {
      return { target: value.target, verification: 'unverified', reason: filled.unverified }
    }
    evidence.push(filled.value)
  }
  return { target: value.target, verification: 'evidence', evidence }
}

function completeObservation(
  value: unknown,
  runs: readonly CommandRun[],
  hostProvenance: EvidenceProvenance | undefined,
  observationProvenance: EvidenceProvenance | undefined,
): { value: unknown } | { unverified: string } {
  if (!isRecord(value)) return { unverified: 'observation-source-unresolved' }
  if (value.method === 'test') return completeTestEvidence(value, runs, hostProvenance)
  if (
    value.method !== 'content-reading' &&
    value.method !== 'prompt-observation' &&
    value.method !== 'manual-interface'
  ) {
    return { unverified: 'observation-source-unresolved' }
  }
  if (Object.hasOwn(value, 'provenance')) return { unverified: 'observation-source-unresolved' }
  if (observationProvenance?.kind !== 'native') return { unverified: 'observation-provenance-unresolved' }
  const parsed = criterionEvidenceSchema.safeParse({
    ...value,
    provenance: observationProvenance,
  })
  if (!parsed.success || parsed.data.method === 'test') return { unverified: 'observation-source-unresolved' }
  return { value: parsed.data }
}

function completeTestEvidence(
  value: Record<string, unknown>,
  runs: readonly CommandRun[],
  hostProvenance: EvidenceProvenance | undefined,
): { value: unknown } | { unverified: string } {
  const afterCited = producerExecution(value.after)
  if (afterCited === null) return { unverified: 'test evidence names no toolCallId' }
  const afterRun = capturedRun(afterCited.toolCallId, runs)
  const provenance = hostNative(hostProvenance, afterCited.toolCallId, runs)
  if (afterRun === null || provenance === null)
    return { unverified: `host capture absent for ${afterCited.toolCallId}` }
  let before: { run: CommandRun; versionClaim: (typeof afterCited)['versionClaim'] } | null = null
  if (value.before != null) {
    const beforeCited = producerExecution(value.before)
    if (beforeCited === null) return { unverified: 'test evidence names no toolCallId' }
    const beforeRun = capturedRun(beforeCited.toolCallId, runs)
    if (beforeRun === null || hostNative(hostProvenance, beforeCited.toolCallId, runs) === null) {
      return { unverified: `host capture absent for ${beforeCited.toolCallId}` }
    }
    before = { run: beforeRun, versionClaim: beforeCited.versionClaim }
  }
  return {
    value: {
      format: CRITERION_EVIDENCE_FORMAT,
      id: typeof value.id === 'string' && value.id.length > 0 ? value.id : afterCited.toolCallId,
      target: value.target,
      code: afterCited.versionClaim.code,
      provenance,
      method: 'test',
      scenario: typeof value.scenario === 'string' && value.scenario.length > 0 ? value.scenario : afterRun.command,
      after: { run: afterRun, versionClaim: afterCited.versionClaim },
      before,
    },
  }
}

function producerExecution(value: unknown): {
  toolCallId: string
  versionClaim: { code: { repository: string; commit: string }; reason: string; references: unknown[] }
} | null {
  if (!isRecord(value) || typeof value.toolCallId !== 'string' || value.toolCallId.length === 0) return null
  const versionClaim = executionVersionClaimSchema.safeParse(value.versionClaim)
  return versionClaim.success ? { toolCallId: value.toolCallId, versionClaim: versionClaim.data } : null
}

function hostNative(
  provenance: EvidenceProvenance | undefined,
  toolCallId: string,
  runs: readonly CommandRun[],
): EvidenceProvenance | null {
  if (provenance?.kind !== 'native') return null
  const captured = new Set(runs.map((run) => run.toolCallId))
  if (!captured.has(toolCallId) || !provenance.toolCallIds.includes(toolCallId)) return null
  if (provenance.toolCallIds.some((id) => !captured.has(id))) return null
  return provenance
}

function capturedRun(toolCallId: string, runs: readonly CommandRun[]): CommandRun | null {
  const run = runs.find((item) => item.toolCallId === toolCallId)
  return run !== undefined &&
    commandRunSchema.safeParse(run).success &&
    commandOutputSchema.safeParse(run.output).success
    ? run
    : null
}
