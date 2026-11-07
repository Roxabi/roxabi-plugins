import type { Scope } from '../engine/record-values.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import type { nativeImplementationGit } from './native-implementation-git.ts'
import type { DeclaredCheckout, withNativeImplementationWorld } from './native-implementation-world.ts'
import type { AdmittedIntegration } from './nested-delivery-integration-admission.ts'
import { admittedIntegration } from './nested-delivery-integration-admission.ts'
import { publishIntegrationReview } from './nested-delivery-integration-review.ts'
import { integrationVerdict } from './nested-delivery-integration-verdict.ts'
import { produceParentIntegration } from './parent-integration-producer.ts'

type World = Parameters<Parameters<typeof withNativeImplementationWorld>[1]>[0]
type ScenarioName = 'complete' | 'middle-missing-coverage' | 'root-missing-child-proof'
export type IntegrationContext = {
  world: World
  git: Pick<ReturnType<typeof nativeImplementationGit>, 'cwd' | 'checkout' | 'tree'>
  scenarioName: ScenarioName
  middle: Scope
  post(scope: Scope, comments: readonly { body: string }[]): Promise<void>
  checkout(branch: string | null, head: string, baseTip: string): DeclaredCheckout
}

function integrationRequest(context: IntegrationContext, scope: Scope, mandate: MandateRecord, child: Scope) {
  return { ...context.world, parentScope: scope, parent: mandate, reviews: [{ uw: child }] }
}

function integrationCheckout(context: IntegrationContext, base: string, head: string) {
  return {
    initial: context.checkout(null, base, head),
    candidate: context.checkout(null, head, head),
    command: 'bun test integration.test.ts',
    output: 'PASS integration',
  }
}
function integrationResult(admitted: AdmittedIntegration) {
  return {
    integratedCode: admitted.code,
    ref: admitted.ref,
    start: admitted.startRecord,
    startInputs: admitted.startRecord.payload.inputs,
    result: admitted.integrated,
    output: admitted.output,
    childCompletion: admitted.childCompletion,
    identity: [...admitted.identityValue.allocations.keys()],
    admission: admitted.read.admission,
  }
}

function integrationOutcome(
  admitted: AdmittedIntegration,
  reviewInputs: Awaited<ReturnType<typeof publishIntegrationReview>>,
) {
  return { ...integrationResult(admitted), code: reviewInputs.manifest.code, reviewInputs }
}

type IntegrationArgs = { scope: Scope; mandate: MandateRecord; child: Scope; base: string; head: string }

async function integrate(context: IntegrationContext, args: IntegrationArgs) {
  const { scope, mandate, child, base, head } = args
  if (mandate.payload.branch !== null) throw new Error('Parent integration must be branchless')
  const request = integrationRequest(context, scope, mandate, child)
  const produced = await produceParentIntegration(request, context.git, integrationCheckout(context, base, head))
  const admitted = admittedIntegration(produced, scope)
  const row = integrationVerdict(context, scope, mandate, admitted)
  const review = await publishIntegrationReview(context, scope, head, admitted, row)
  return integrationOutcome(admitted, review)
}

export async function integrateNestedDelivery(
  context: IntegrationContext,
  scope: Scope,
  mandate: MandateRecord,
  child: Scope,
  base: string,
  head: string,
) {
  return integrate(context, { scope, mandate, child, base, head })
}
