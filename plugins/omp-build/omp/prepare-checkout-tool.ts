import {
  ompBuildPrepareCheckoutParametersJsonSchema,
  ompBuildPrepareCheckoutParametersSchema,
} from '../dist/contracts.js'
import { prepareCanonicalCheckout } from '../roxabi/prepare-canonical-checkout.ts'
import type { OmpBuildExtensionApi } from './omp-controller'

export function registerPrepareCheckoutTool(pi: Pick<OmpBuildExtensionApi, 'registerTool'>): void {
  pi.registerTool({
    name: 'omp_build_prepare_checkout',
    label: 'Prepare canonical checkout',
    description:
      "Prepare or reuse the canonical worktree for one unambiguous issue reference. A pull-request number checks out that request's existing head and does not mint an issue branch. Requires host write approval. Returns ready, move, or blocked with the checkout path. Does not publish a mandate, binding, or execution receipt, bootstrap dependencies, resume a stopped workflow, move the session, or simulate /feature.",
    parameters: ompBuildPrepareCheckoutParametersJsonSchema,
    approval: 'write',
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      const parsed = ompBuildPrepareCheckoutParametersSchema.safeParse(params)
      if (!parsed.success) throw new Error('invalid-omp-build-prepare-checkout-parameters')
      const result = await prepareCanonicalCheckout({ reference: parsed.data.reference, sessionCwd: ctx.cwd })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    },
  })
}
