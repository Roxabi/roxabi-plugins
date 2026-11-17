import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import type { Scope } from '../record-values.ts'
import { canonicalSpec } from '../uw-spec.ts'

export function deliverySpecBodies(
  parentCriteria: Readonly<Parameters<typeof canonicalSpec>[0]['criteria']>,
  existingBody?: string,
) {
  const content = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement: 'Save keeps the selected region' }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  const parentContent = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [...parentCriteria],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!content.ok || !parentContent.ok) throw new Error('Invalid native fixture Spec')
  return {
    body: renderIssueSpecBody(content.value, { complexity: 1 }),
    parentBody: existingBody ?? renderIssueSpecBody(parentContent.value, { complexity: 1 }),
  }
}

export function deliverySpecSnapshot(scope: Scope, body: string, date: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, date) })
  if (parsed.status !== 'conformant') throw new Error(`Invalid framed native Spec for ${scope.target}`)
  return parsed.snapshot
}
