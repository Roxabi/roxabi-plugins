type Gh = (cwd: string, args: string[]) => string | Promise<string>
type Repo = { owner: string; repo: string }
type Policy = { repositoryId: number; operatorIds: number[]; appId: number; botUserId: number }
type Scope = {
  repositoryId: number
  pullRequestId: number
  pullRequest: number
  headSha: string
  baseRef: string
  baseSha: string
  authorId: number
}
type RecordData = {
  version: 1
  kind: 'grant' | 'withdraw'
  operationId: string
  repositoryId: number
  pullRequestId: number
  pullRequest: number
  headSha: string
  baseRef: string
  baseSha: string
  lane: string
  source: string
  previous: number | null
  evidence: string
}
type Receipt = { id: number; operationId: string | null; body: string; record: RecordData | null; createdAt?: string }
type Options = { cwd?: string; gh?: Gh; repo?: Repo; policy: Policy }
type Snapshot = { scope: Scope; previous: number | null; repo: Repo }
export function policyFromEnv(env?: NodeJS.ProcessEnv): Policy
export function policyFromRepository(args?: { cwd?: string; gh?: Gh; repo?: Repo }): Promise<Policy | null>
export function resolveRepository(args?: { cwd?: string; gh?: Gh }): Promise<Repo>
export function captureAuthorization(args: Options & { prNumber: number }): Promise<Snapshot>
export function readAuthorization(
  args: Options & { prNumber: number },
): Promise<{ scope: Scope; allowed: boolean; receipt: Receipt | null; reason: string | null; previous: number | null }>
export function issueAuthorization(
  args: Options & {
    snapshot: Snapshot
    lane: string
    source: string
    evidence: string
    operationId: string
    requireBaseSha?: boolean
  },
): Promise<Receipt>
export function withdrawAuthorization(
  args: Options & { prNumber: number; operationId: string; reason: string },
): Promise<Receipt>
