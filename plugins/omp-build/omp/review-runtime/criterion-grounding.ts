import type {
  CommandOutput,
  CommandRun,
  EvidenceProvenance,
  GitBoundaryObservation,
} from '../../engine/criterion-evidence-schema.ts'
import { object } from './capture'
import type { Json, NativeProofBashCall } from './contracts'

type CapturedView = Extract<CommandOutput, { kind: 'sdk-view' }>

function commandOf(input: Json): string | null {
  return object(input) && typeof input.command === 'string' ? input.command : null
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null
  return value
    .reduce<string[]>((parts, part) => {
      if (object(part) && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
      return parts
    }, [])
    .join('')
}

function knownIncomplete(result: Record<string, unknown>): boolean {
  const details = object(result.details) ? result.details : null
  const meta = details && object(details.meta) ? details.meta : null
  if (meta === null) return false
  const truncation = object(meta.truncation) ? meta.truncation : null
  const limits = object(meta.limits) ? meta.limits : null
  const column = limits && object(limits.columnTruncated) ? limits.columnTruncated : null
  return truncation !== null || column !== null || (meta.artifactError !== undefined && meta.artifactError !== null)
}

/** An SDK-presented view, not process bytes or a claim of completeness. */
function capturedOutput(result: Json | null): CapturedView | null {
  if (!object(result)) return null
  const text = textOf(result.content)
  if (text === null) return null
  return {
    kind: 'sdk-view',
    text,
    source: 'native-tool-result',
    completeness: knownIncomplete(result) ? 'known-incomplete' : 'potentially-incomplete',
  }
}

export function commandRunFromCapture(
  call: NativeProofBashCall,
  context: {
    probeCwd: string | null
    start: GitBoundaryObservation | null
    end: GitBoundaryObservation | null
  },
): CommandRun | null {
  const command = commandOf(call.input)
  if (command === null || call.exitCode === null || !Number.isInteger(call.exitCode)) return null
  const output = capturedOutput(call.result)
  if (output === null) return null
  return { toolCallId: call.toolCallId, command, exitCode: call.exitCode, output, context }
}

export function nativeProvenance(
  actionId: string,
  childId: string,
  submissionIndex: number,
  toolCallIds: readonly string[],
): Extract<EvidenceProvenance, { kind: 'native' }> {
  return { kind: 'native', actionId, childId, submissionIndex, toolCallIds: [...toolCallIds] }
}

/** Tool-call ids cited by a structured child result. Uncited calls are not grounded. */
export function referencedCommandIds(structured: Json | null): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (id: unknown): void => {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!object(value)) return
    add(value.toolCallId)
    if (Array.isArray(value.toolCallIds)) for (const id of value.toolCallIds) add(id)
    for (const nested of Object.values(value)) visit(nested)
  }
  visit(structured)
  return ids
}
