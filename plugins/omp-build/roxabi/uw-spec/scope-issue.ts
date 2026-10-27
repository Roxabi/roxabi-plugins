import type { GitHubOptions } from '../../adapters/github/types.ts'
import { readNativeIssueFacts, scopeNumber } from '../../adapters/github-native/issue-facts.ts'
import type { Scope } from '../../engine/record-values.ts'

/** Fail-closed exact issue body reader for an opaque Scope. Missing body refuses. */
export async function readScopeIssueBody(scope: Scope, options: GitHubOptions): Promise<string> {
  const facts = await readNativeIssueFacts(scope.repository, scopeNumber(scope), options)
  return facts.body
}
