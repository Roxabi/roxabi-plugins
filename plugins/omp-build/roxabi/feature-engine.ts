// Source: plugins/omp-build/roxabi/workflow.ts:244-287,312-314,529-560
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Gh } from '../adapters/github/types.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Diagnostic, Scope } from '../engine/record-values.ts'
import { authorizeStartPublication, recheckStartPublication } from './feature-start-publication.ts'

const execFileAsync = promisify(execFile)

const requiredContractNames = [
  'reconstructWorkflow',
  'selectApplicableMandate',
  'resolveOwnSpecAuthority',
  'effectiveMandateRole',
  'specDigest',
  'shippedProductVersion',
  'buildRecord',
  'publishConfirmedWorkflowRecord',
  'readComposedWorkflowHistory',
  'resolveNativeTarget',
  'resolveNativeScope',
  'readLinkedIssueAssociation',
  'readIssueParentAssociation',
  'githubScope',
  'composeChantier',
  'planMacro',
  'planDigest',
  'failedCheckEvidenceDigest',
  'resolveAcceptedSpec',
  'bindExternalRef',
] as const

type RequiredContractName = (typeof requiredContractNames)[number]

export type Contracts = Pick<typeof import('../contracts.ts'), RequiredContractName>
export type History = DecodedHistory
export type HistoryRecord = NonNullable<History['operations'][number]['record']>
export type { WorkflowEvidence } from '../engine/workflow-plan.ts'
export type { Gh, Scope }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCallable(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

export async function loadContracts(): Promise<Contracts | { missing: string }> {
  const imported: Contracts = await import('../dist/contracts.js')
  if (!isRecord(imported)) return { missing: 'dist/contracts.js' }
  for (const name of requiredContractNames) {
    if (!isCallable(imported[name])) return { missing: name }
  }
  return imported
}

export function defaultGh(): Gh {
  return async (cwd, args) => {
    const out = await execFileAsync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return out.stdout
  }
}

export function payload<Record extends HistoryRecord>(record: Record): Record['payload'] {
  return record.payload
}

export async function publishRecord(
  contracts: Contracts,
  history: History,
  draft: Parameters<Contracts['buildRecord']>[0],
  gh: Gh,
  cwd: string,
  externalHistories?: readonly History[],
  canPublish?: () => boolean,
): Promise<{ ok: true } | { ok: false; reason: string; diagnostics?: readonly Diagnostic[] }> {
  const built = contracts.buildRecord(draft)
  if (!built.ok) {
    return {
      ok: false,
      reason: built.diagnostics.map((item) => item.code).join(',') || 'record-invalid',
      diagnostics: built.diagnostics,
    }
  }
  const histories = [history, ...(externalHistories ?? [])]
  const authorized = await authorizeStartPublication(built.value, contracts, histories, cwd, gh)
  if (!authorized.ok) return authorized
  const published = await contracts.publishConfirmedWorkflowRecord(
    built.value,
    history,
    { cwd, gh, ...(canPublish === undefined ? {} : { canPublish }) },
    null,
    externalHistories,
  )
  if (published.status !== 'confirmed') {
    return {
      ok: false,
      reason: published.status,
      diagnostics: Array.isArray(published.diagnostics) ? published.diagnostics : undefined,
    }
  }
  const rechecked = await recheckStartPublication(built.value, contracts, histories, cwd, gh)
  if (!rechecked.ok) return rechecked
  return { ok: true }
}
