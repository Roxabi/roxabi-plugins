import type { FixActionResult } from './fix-contract.ts'

export const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
export const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export type Size = 'S' | 'F-lite' | 'F-full'

export type ProcessResult = { stdout: string; stderr: string; exitCode?: number }
export type ProcessRunner = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<ProcessResult>

export type Ref = { repository: string; number: number }
export type Source = { origin: string; issue: Ref | null; parent: Ref | null; size: Size }
export type DebtIssue = {
  number: number
  title: string
  body: string
  author: string | null
  labels: string[]
  type: string | null
  parent: Ref | null
  blockedBy: Ref[]
}

export function failure<T>(...diagnostics: string[]): FixActionResult<T> {
  return { ok: false, diagnostics }
}
