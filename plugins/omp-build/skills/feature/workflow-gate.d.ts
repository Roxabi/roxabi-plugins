import type { Gh } from './proof-base.ts'

export type GateState = 'OPEN' | 'CLOSED' | 'MERGED'
export type GateLabel = { name: string }
export type NativeAutoMergeRequest = {
  enabledAt?: string
  mergeMethod?: 'MERGE' | 'REBASE' | 'SQUASH'
}
export type Gate = {
  state: GateState
  labels: GateLabel[]
  autoMergeRequest: NativeAutoMergeRequest | { pinned: true } | null
  headRefOid?: string
  mergeStateStatus?: string
}
export type ReviewGateRecords = { spent: boolean; verdict: string | null; head: string | null }
export type ArmedGatePolicy = 'allow-approved' | 'unarmed'
export type ArmedGateReceipt = { allowed: true } | { allowed: false; disarmed?: true }

export declare function isCommitSha(value: string | null | undefined): boolean
export declare function readPrFields(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  fields: 'headRefOid',
): Promise<{ headRefOid: string }>
export declare function readPrFields(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  fields: 'baseRefName',
): Promise<{ baseRefName: string }>
export declare function readPrFields(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  fields: 'headRefName,body',
): Promise<{ headRefName: string; body: string }>
export declare function readHeadRefOid(cwd: string, pr: number | string, ghFn: Gh): Promise<string | undefined>
export declare function readGate(cwd: string, pr: number | string, ghFn?: Gh): Promise<Gate>
export declare function isBehind(gate: Gate | null | undefined): boolean
export declare function behindMessage(pr: number | string): string
export declare function disarmGate(cwd: string, pr: number | string, gate: Gate, ghFn: Gh): Promise<boolean>
export declare function approves(verdict: string | null | undefined): boolean
export declare function reviewBoundStopped(records: Pick<ReviewGateRecords, 'spent'>): boolean
export declare function mayStayArmed(records: ReviewGateRecords, gate: Gate, reviewing: boolean): boolean
export declare function enforceArmedGate(
  cwd: string,
  pr: number | string,
  options: { records?: ReviewGateRecords; gate?: Gate; reviewing?: boolean; policy?: ArmedGatePolicy; gh?: Gh },
): Promise<ArmedGateReceipt>
