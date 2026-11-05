import type { FindingTarget } from './finding-target-schema.ts'
import { equalScope } from './record-diagnostics.ts'
import type { Scope } from './record-values.ts'
import type { Result } from './result.ts'
import { type SpecEffective, sameOwnSpecRef } from './spec-effective.ts'

export type CauseContext = { original: Scope; effective: SpecEffective }

export function validateLocalFindingTarget(input: {
  context: CauseContext
  target: FindingTarget
}): Result<FindingTarget> {
  const { original, effective } = input.context
  const target = input.target
  if (!equalScope(original, effective.own.uw))
    return {
      ok: false,
      diagnostics: [{ code: 'cause-origin-mismatch', message: 'The original UW does not match the accepted Spec.' }],
    }
  if (target.kind === 'outside-spec') {
    return equalScope(target.uw, original)
      ? { ok: true, value: target }
      : {
          ok: false,
          diagnostics: [{ code: 'finding-target-foreign', message: 'Outside-Spec target must name the original UW.' }],
        }
  }
  if (!sameOwnSpecRef(target.spec, effective.own))
    return {
      ok: false,
      diagnostics: [
        { code: 'finding-target-spec-mismatch', message: 'Finding target must name the exact accepted local Spec.' },
      ],
    }
  const found =
    target.kind === 'criterion'
      ? effective.spec.criteria.some((item) => item.id === target.id)
      : effective.spec.invariants.some((item) => item.id === target.id)
  return found
    ? { ok: true, value: target }
    : {
        ok: false,
        diagnostics: [
          {
            code: 'finding-target-unknown',
            message: 'Finding target is not an obligation in the accepted local Spec.',
          },
        ],
      }
}
