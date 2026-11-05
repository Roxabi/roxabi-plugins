import { type GitHubOptions, readCauseReports, readComposedWorkflowHistory, readUwSubtree } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import { UwGraphUnavailableError } from './uw-read-port.ts'
export function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

export function diagnostics(
  uw: Scope,
  values: readonly { code?: unknown; message?: unknown }[],
): readonly UwDiagnostic[] {
  return values.map((value) =>
    diagnostic(
      uw,
      typeof value.code === 'string' ? value.code : 'uw-publication-unconfirmed',
      typeof value.message === 'string' ? value.message : 'UW publication was not confirmed',
    ),
  )
}
export function postEffectDiagnostics(uw: Scope, error: unknown): readonly UwDiagnostic[] {
  if (error instanceof UwGraphUnavailableError) return error.diagnostics
  return [
    diagnostic(
      uw,
      'post-effect-read-failed',
      error instanceof Error ? error.message : 'UW read failed after durable effects',
    ),
  ]
}

export async function listInstalledReports(uw: Scope, github: GitHubOptions) {
  try {
    const graph = await readUwSubtree(uw, github)
    if (graph.status !== 'complete') return { ok: false as const, diagnostics: [...graph.diagnostics] }
    const subtree = graph.nodes.map((node) => node.uw)
    const histories = await readComposedWorkflowHistory(subtree, github)
    if (!histories.ok) return { ok: false as const, diagnostics: [...diagnostics(uw, histories.diagnostics)] }
    const result = readCauseReports({ root: uw, subtree, histories: histories.histories })
    return result.ok ? result : { ok: false as const, diagnostics: [...diagnostics(uw, result.diagnostics)] }
  } catch (error) {
    return { ok: false as const, diagnostics: [...postEffectDiagnostics(uw, error)] }
  }
}
