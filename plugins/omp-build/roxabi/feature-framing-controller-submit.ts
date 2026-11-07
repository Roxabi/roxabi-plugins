import { framingFormInputSchema } from '../dist/contracts.js'
import type { FramingForm } from '../engine/framing-form-schema.ts'
import type { FramingSubmissionResult } from './feature-framing-contract.ts'
import type { SubmitActual } from './feature-framing-controller-form-gate.ts'
import { applyFramingForm } from './feature-framing-controller-forms.ts'
import {
  asUwDiagnostics,
  blockLease,
  type ControllerCore,
  currentStage,
  framingDiagnostic,
  type LeaseState,
  live,
  maybeFinalize,
  revokeLease,
  sameLocation,
  sameSession,
  submission,
  terminal,
} from './feature-framing-controller-lease.ts'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/** Native-issue material is refused before parsing; then the strict schema and the exact current token. */
function admitForm(lease: LeaseState, input: unknown): { form: FramingForm } | { refusal: FramingSubmissionResult } {
  const raw = typeof input === 'object' && input !== null && 'form' in input ? input.form : undefined
  if (typeof raw === 'object' && raw !== null && 'kind' in raw && raw.kind === 'material' && 'issue' in raw)
    return {
      refusal: submission(lease, 'refused', [
        framingDiagnostic(
          lease,
          'framing-material-native-issue',
          'Existing issues are selected as members, never captured as material',
        ),
      ]),
    }
  const parsed = framingFormInputSchema.safeParse(input)
  if (!parsed.success)
    return {
      refusal: submission(
        lease,
        'refused',
        asUwDiagnostics(
          lease,
          parsed.error.issues.map((issue) => ({
            code: 'framing-form-invalid',
            message: `${issue.path.map(String).join('.')}: ${issue.message}`,
          })),
        ),
      ),
    }
  const token = lease.token
  const phaseAccepts = lease.phase.kind === 'interview' || lease.phase.kind === 'proposal-ready'
  const tokenCurrent =
    token !== null &&
    parsed.data.supplyToken === token.value &&
    token.revision === lease.revision &&
    token.stage === currentStage(lease)
  if (!tokenCurrent || !phaseAccepts)
    return {
      refusal: submission(lease, 'refused', [
        framingDiagnostic(
          lease,
          'framing-supply-token-stale',
          'Use the supply token from the latest framing projection',
        ),
      ]),
    }
  return { form: parsed.data.form }
}
export async function submitFramingForm(
  core: ControllerCore,
  input: unknown,
  actual: SubmitActual,
): Promise<FramingSubmissionResult> {
  /** Session gates in trust order: same root session, same location (else revoke), live call, one form at a time. */
  function sessionRefusal(lease: LeaseState, actual: SubmitActual): FramingSubmissionResult | null {
    const refuse = (code: string, message: string) =>
      submission(lease, 'refused', [framingDiagnostic(lease, code, message)])
    if (!sameSession(lease.origin, actual.ctx))
      return refuse('framing-root-required', 'Only the root session that began framing may submit forms')
    if (!sameLocation(lease.origin, actual.ctx)) {
      revokeLease(core, lease, 'framing-location-changed')
      return refuse('framing-location-changed', 'The session location changed; framing is revoked')
    }
    if (actual.signal.aborted) return refuse('framing-submit-aborted', 'The submission was aborted')
    if (lease.submitting) return refuse('framing-form-concurrent', 'Another framing form is being applied')
    return null
  }

  async function submit(input: unknown, actual: SubmitActual): Promise<FramingSubmissionResult> {
    const lease = core.current
    if (lease === null || !live(core, lease) || terminal(lease.phase))
      return submission(lease, 'refused', [
        framingDiagnostic(lease, 'framing-inactive', 'No framing interview is active'),
      ])
    const refusal = sessionRefusal(lease, actual)
    if (refusal !== null) return refusal
    const admitted = admitForm(lease, input)
    if ('refusal' in admitted) return admitted.refusal
    lease.submitting = true
    lease.inflight += 1
    try {
      return await applyFramingForm(core, lease, admitted.form, actual)
    } catch (error) {
      blockLease(core, lease, 'framing-submit-failed', actual.ctx, `feature-framing blocked: ${errorText(error)}`)
      return submission(lease, 'refused', [framingDiagnostic(lease, 'framing-submit-failed', errorText(error))])
    } finally {
      lease.submitting = false
      lease.inflight -= 1
      maybeFinalize(core, lease)
    }
  }
  return submit(input, actual)
}
