import { isDeepStrictEqual } from 'node:util'
import { validateActionInputs } from '../../dist/contracts.js'
import type { ContextActionBinding } from '../../engine/action-context.ts'
import type { ActionInputs } from '../../engine/action-input-schema.ts'
import type { Result } from '../../engine/result.ts'
import type { ActionSnapshot } from '../../roxabi/uw-action-contract.ts'

const verifiers = new WeakMap<ActionSnapshot, (snapshot: ActionSnapshot) => Promise<Result<ActionSnapshot>>>()
const bindings = new WeakMap<ActionSnapshot, ContextActionBinding>()

/** Capture the host-prepared inputs against the registered snapshot identity. */
export function registerHostActionBinding(snapshot: ActionSnapshot, inputs: ActionInputs): void {
  const valid = validateActionInputs(inputs)
  if (
    !verifiers.has(snapshot) ||
    !valid.ok ||
    valid.value.fingerprint !== snapshot.manifestDigest ||
    bindings.has(snapshot)
  ) {
    throw new TypeError('action binding does not match the registered snapshot')
  }
  bindings.set(snapshot, structuredClone({ actionId: snapshot.actionId, inputs: valid.value }))
}

export function hostActionBinding(snapshot: ActionSnapshot, inputs: ActionInputs): ContextActionBinding | null {
  const binding = bindings.get(snapshot)
  return binding !== undefined && isDeepStrictEqual(binding.inputs, inputs) ? structuredClone(binding) : null
}

function failure(code: string, message: string): Result<ActionSnapshot> {
  return { ok: false, diagnostics: [{ code, message }] }
}

/** Bind the canonical snapshot verifier to this object identity. The function is not a baseline. */
export function registerHostActionHandle(
  snapshot: ActionSnapshot,
  verifier: (snapshot: ActionSnapshot) => Promise<Result<ActionSnapshot>>,
): void {
  verifiers.set(snapshot, verifier)
}

export function registeredHostAction(snapshot: ActionSnapshot): boolean {
  return verifiers.has(snapshot)
}

export function verifyHostAction(snapshot: ActionSnapshot): Promise<Result<ActionSnapshot>> {
  const verifier = verifiers.get(snapshot)
  if (verifier === undefined) {
    return Promise.resolve(failure('action-handle-unregistered', 'The action snapshot is not a registered host handle'))
  }
  return Promise.resolve()
    .then(() => verifier(snapshot))
    .catch((error: unknown) =>
      failure('snapshot-unreadable', error instanceof Error ? error.message : 'registered action verifier failed'),
    )
}
