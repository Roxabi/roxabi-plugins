import { issueSpecAnalysisSchema, parseIssueSpecBody, rawSource } from '../dist/contracts.js'
import type { Result } from '../engine/result.ts'
import { ACCEPTED_PURPOSE } from './uw-action-accepted-state.ts'
import type { ActionInputManifest, ActionSubject, UwActionRequest } from './uw-action-contract.ts'
import type { ActionFactSource } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'

export async function proposedSpec(
  request: UwActionRequest,
  subject: Extract<ActionSubject, { kind: 'uw' }>,
  source: ActionFactSource,
  current: ActionInputManifest['spec'],
): Promise<Result<ActionInputManifest['spec']>> {
  if (ACCEPTED_PURPOSE[request.purpose] || request.purpose === 'assess-spec') return { ok: true, value: current }
  const uw = subject.uw
  const body = await source.gh(source.cwd, [
    'issue',
    'view',
    uw.target.split('#').at(-1) ?? '',
    '--repo',
    uw.repository,
    '--json',
    'body,updatedAt',
  ])
  const issue = JSON.parse(body) as { body?: string; updatedAt?: string }
  const parsed = parseIssueSpecBody({ uw, raw: rawSource(uw.target, issue.body ?? '', issue.updatedAt ?? null) })
  if (parsed.status === 'conformant') return { ok: true, value: { kind: 'proposed', uw, snapshot: parsed.snapshot } }
  const analysis = issueSpecAnalysisSchema.safeParse(parsed.analysis)
  if (!analysis.success) return actionFailure('action-input-missing', 'Unframed parser facts are not readable')
  return {
    ok: true,
    value: {
      kind: 'unframed',
      uw,
      source: rawSource(uw.target, issue.body ?? '', issue.updatedAt ?? null),
      parser: {
        status: parsed.status,
        diagnostics: [...parsed.diagnostics],
        analysis: analysis.data,
        draft: parsed.status === 'draft' ? parsed.draft : null,
      },
    },
  }
}
