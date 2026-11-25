import type { Gh } from '../adapters/github/types.ts'
import type { NativeTargetResolution } from '../adapters/github-workflow/types.ts'
import type { Scope } from '../engine/record-values.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type Contracts, isRecord } from './feature-engine.ts'
import { classifyIssueReference } from './prepare-canonical-checkout.ts'

type NativeContext = { cwd: string; gh: Gh; engine: Contracts }
export type ResolvedTarget = Extract<NativeTargetResolution, { status: 'issue' | 'pull-request' }>
type Refusal = Extract<ContinueFeatureResult, { kind: 'blocked' }>

/** Resolve an existing issue without consulting a pull request's workflow binding. */
export async function resolveFramingReference(input: NativeContext & { reference: string }): Promise<Scope | Refusal> {
  const target = await resolveFeatureNativeTarget(input.reference, input)
  if ('kind' in target) return target
  return target.status === 'issue' ? target.scope : { kind: 'blocked', reason: 'framing-reference-not-issue' }
}

export async function resolveFeatureNativeTarget(
  reference: string,
  context: NativeContext,
  exactScope?: Scope,
): Promise<ResolvedTarget | Refusal> {
  const classified = classifyIssueReference(reference)
  const scope =
    exactScope ??
    (!('reason' in classified) && classified.repository !== null
      ? context.engine.githubScope(classified.repository, classified.number)
      : null)
  if (scope !== null) {
    const problem = await verifyRepository(context, scope.repository)
    if (problem !== null) return problem
  }
  const options = { cwd: context.cwd, gh: context.gh }
  const target =
    scope === null
      ? await context.engine.resolveNativeTarget(reference, options)
      : await context.engine.resolveNativeScope(scope, options)
  return target.status === 'issue' || target.status === 'pull-request'
    ? target
    : { kind: 'blocked', reason: target.status }
}

async function verifyRepository({ cwd, gh }: NativeContext, repository: string): Promise<Refusal | null> {
  try {
    const current: unknown = JSON.parse(await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner']))
    return isRecord(current) && current.nameWithOwner === repository
      ? null
      : { kind: 'blocked', reason: 'repository-mismatch' }
  } catch {
    return { kind: 'blocked', reason: 'repository-unreadable' }
  }
}
