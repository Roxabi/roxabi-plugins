import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { parentCoverageSchema } from '../engine/workflow-mandate-schema.ts'
import type { FeatureCommandHost } from '../roxabi/feature-contract.ts'
import { rootContext } from './omp-feature-session.ts'

type CoverageHandler = NonNullable<FeatureCommandHost['requestParentCoverage']>
type CoverageRequest = Parameters<CoverageHandler>[0]

function canEditCoverage(ctx: ExtensionContext): boolean {
  return rootContext(ctx) && ctx.hasUI && ctx.mode === 'tui'
}

export async function requestParentCoverage(
  ctx: ExtensionContext,
  request: CoverageRequest,
): ReturnType<CoverageHandler> {
  if (!canEditCoverage(ctx)) return { kind: 'cancelled' }
  const draft = {
    context: request,
    coverage:
      request.children.length === 0
        ? null
        : {
            parent: request.parent,
            assignments: request.criteria.map((criterion) => ({ criterion: criterion.id, children: [] })),
          },
  }
  try {
    const edited = await ctx.ui.editor(
      'Assign children to every parent criterion in coverage.assignments',
      JSON.stringify(draft, null, 2),
    )
    if (edited === undefined || !canEditCoverage(ctx)) return { kind: 'cancelled' }
    const value: unknown = JSON.parse(edited)
    if (typeof value !== 'object' || value === null || !('coverage' in value)) return { kind: 'cancelled' }
    const parsed =
      value.coverage === null ? { success: true as const, data: null } : parentCoverageSchema.safeParse(value.coverage)
    if (!parsed.success) return { kind: 'cancelled' }
    if (request.accepted !== null) return { kind: 'proposed', coverage: parsed.data }
    const confirmed = await ctx.ui.confirm(
      'Confirm parent coverage',
      JSON.stringify({ context: request, coverage: parsed.data }, null, 2),
    )
    return confirmed && canEditCoverage(ctx) ? { kind: 'proposed', coverage: parsed.data } : { kind: 'cancelled' }
  } catch {
    return { kind: 'cancelled' }
  }
}
