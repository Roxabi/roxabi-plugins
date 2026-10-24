import { isAbsolute } from 'node:path'
import { CHANGES_DIR, errorMessage, isMap, type Refusal, refuse } from './proof-base'
import {
  type ChangeResult,
  changeIdOf,
  type SemctxExpected,
  type Step,
  semctxSteps,
  stepExitAllowed,
} from './proof-semctx-protocol'
import { changeResult } from './proof-semctx-validation-result'

type SemctxRecordParts = Record<string, unknown> & { invocation: Record<string, unknown>; native: unknown[] }

export function parseJson(step: Step | undefined): unknown {
  if (!step) throw new Error('a native step is missing')
  try {
    return JSON.parse(step.stdout)
  } catch {
    throw new Error(`${step.argv.slice(2).join(' ')} printed no JSON`)
  }
}

export function isStep(value: unknown): value is Step {
  return (
    isMap(value) &&
    Array.isArray(value.argv) &&
    value.argv.every((arg) => typeof arg === 'string') &&
    Number.isInteger(value.exit) &&
    typeof value.stdout === 'string'
  )
}

export function sameList(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i])
}

/** Stable text of a JSON value, for the before/after seal comparison. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isMap(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function unbound(error: string): Refusal {
  return refuse('semctx', 'unbound', `the Semctx record does not bind: ${error}`)
}

function hasRecordParts(record: unknown): record is SemctxRecordParts {
  return isMap(record) && record.producer === 'semctx' && isMap(record.invocation) && Array.isArray(record.native)
}

function expectedFieldError(invocation: Record<string, unknown>, expected: SemctxExpected): string | undefined {
  const fields: [keyof SemctxExpected, unknown][] = [
    ['repository', invocation.repository],
    ['pr', invocation.pr],
    ['candidate', invocation.candidate],
    ['base', invocation.base],
    ['mergeBase', invocation.mergeBase],
  ]
  for (const [key, value] of fields) {
    if (value !== expected[key]) return `${key} ${JSON.stringify(value)} ≠ ${JSON.stringify(expected[key])}`
  }
  return undefined
}

function invocationIdentityError(invocation: Record<string, unknown>, expected: SemctxExpected): string | undefined {
  const fieldError = expectedFieldError(invocation, expected)
  if (fieldError) return fieldError
  if (!sameList(invocation.contracts, expected.contracts)) {
    return `contracts ${JSON.stringify(invocation.contracts)} ≠ changed ${JSON.stringify(expected.contracts)}`
  }
  if (
    !isMap(invocation.config) ||
    invocation.config.source !== expected.config.source ||
    invocation.config.sha256 !== expected.config.sha256
  ) {
    return `the run's Semctx configuration ${JSON.stringify(invocation.config)} is not the ${expected.config.source} one in force now (sha256 ${expected.config.sha256})`
  }
  return undefined
}

function checkoutBindingError(invocation: Record<string, unknown>): string | undefined {
  if (!isMap(invocation.status) || invocation.status.before !== '' || invocation.status.after !== '') {
    return 'the private checkout was not clean before and after the run'
  }
  if (
    !Array.isArray(invocation.ignored) ||
    invocation.ignored.some((path) => typeof path !== 'string' || path.startsWith('.semctx/working/'))
  ) {
    return 'the private checkout held Semctx working state'
  }
  if (
    !isMap(invocation.tool) ||
    typeof invocation.tool.version !== 'string' ||
    typeof invocation.tool.path !== 'string'
  ) {
    return 'no tool path/version'
  }
  return undefined
}

function nativeSteps(native: unknown[], root: string, expected: SemctxExpected): Step[] | string {
  const steps = semctxSteps(root, expected.contracts, expected.mergeBase, expected.candidate)
  if (native.length !== steps.length || !native.every(isStep)) return `expected ${steps.length} native steps`
  for (const [index, step] of native.entries()) {
    if (!sameList(step.argv, steps[index] ?? [])) return `step ${index + 1} ran ${JSON.stringify(step.argv)}`
    if (!stepExitAllowed(step.argv).includes(step.exit)) return `step ${index + 1} exited ${step.exit}`
  }
  return native
}

function freshnessSeal(
  label: string,
  step: Step | undefined,
  expected: SemctxExpected,
  root: string,
): string | Refusal {
  const status = parseJson(step)
  if (!isMap(status) || status.verdict !== 'FRESH' || !isMap(status.freshnessSeal)) {
    return unbound(`status ${label} the run is not FRESH`)
  }
  const seal = status.freshnessSeal
  if (seal.headAtCapture !== expected.candidate || seal.indexedHeadCommit !== expected.candidate) {
    return unbound(`status ${label} the run is sealed at ${String(seal.headAtCapture)}, not ${expected.candidate}`)
  }
  if (seal.indexedRepositoryRoot !== root) return unbound(`status ${label} the run indexed another root`)
  return canonical(seal)
}

function semanticCheckError(check: Record<string, unknown>, expected: SemctxExpected): Refusal | undefined {
  if (check.ok !== true || !isMap(check.counts) || check.counts.errors !== 0) {
    return refuse('semctx', 'verdict', 'semantic check reports errors in the candidate model')
  }
  if (check.counts.changes !== expected.changeFiles.length) {
    return refuse(
      'semctx',
      'verdict',
      `the model declares ${String(check.counts.changes)} change(s) but the candidate commits ${expected.changeFiles.length} change file(s): each change must be the one block of its own ${CHANGES_DIR}<id>.sem`,
    )
  }
  return undefined
}

function lifecycleFindingError(finding: unknown, committed: ReadonlySet<string>): Refusal | undefined {
  if (!isMap(finding) || typeof finding.code !== 'string')
    throw new Error('semantic check reports a malformed lifecycle finding')
  if (!finding.code.startsWith('ACTIVE_CHANGE_')) return undefined
  if (finding.code !== 'ACTIVE_CHANGE_POINTER_MISSING') {
    return refuse(
      'semctx',
      'unbound',
      `semantic check reports ${finding.code} in a checkout that holds no active pointer`,
    )
  }
  const ids = finding.subjectIds
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string'))
    throw new Error(`${finding.code} names no subject ids`)
  const hidden = ids.filter((id) => !committed.has(id))
  if (hidden.length) {
    return refuse(
      'semctx',
      'verdict',
      `non-terminal change(s) ${hidden.join(', ')} are not committed as their own ${CHANGES_DIR}<id>.sem: a change outside its contract file escapes verification`,
    )
  }
  return undefined
}

function lifecycleError(check: Record<string, unknown>, expected: SemctxExpected): Refusal | undefined {
  if (!Array.isArray(check.lifecycleFindings)) throw new Error('semantic check reports no lifecycleFindings')
  const committed = new Set(expected.changeFiles.map(changeIdOf))
  for (const finding of check.lifecycleFindings) {
    const error = lifecycleFindingError(finding, committed)
    if (error) return error
  }
  return undefined
}

function changeResults(native: Step[], expected: SemctxExpected): ChangeResult[] | Refusal {
  const results: ChangeResult[] = []
  for (const [index, path] of expected.contracts.entries()) {
    const id = changeIdOf(path)
    const inspect = parseJson(native[3 + 2 * index])
    const verify = parseJson(native[4 + 2 * index])
    const result = changeResult(id, path, inspect, verify, expected)
    if ('ok' in result) return result
    results.push(result)
  }
  return results
}

export function readSemctxRecord(record: unknown, expected: SemctxExpected): ChangeResult[] | Refusal {
  if (!hasRecordParts(record)) {
    return refuse('semctx', 'unreadable', 'the Semctx record has no producer/invocation/native parts')
  }
  const identityError = invocationIdentityError(record.invocation, expected)
  if (identityError) return unbound(identityError)
  const root = record.invocation.root
  if (typeof root !== 'string' || !isAbsolute(root)) return unbound('no private checkout root')
  const checkoutError = checkoutBindingError(record.invocation)
  if (checkoutError) return unbound(checkoutError)
  const native = nativeSteps(record.native, root, expected)
  if (typeof native === 'string') return unbound(native)
  try {
    const beforeSeal = freshnessSeal('before', native[1], expected, root)
    if (typeof beforeSeal !== 'string') return beforeSeal
    const afterSeal = freshnessSeal('after', native.at(-1), expected, root)
    if (typeof afterSeal !== 'string') return afterSeal
    if (beforeSeal !== afterSeal) return unbound('the freshness seal changed during the run')
    const check = parseJson(native[2])
    if (!isMap(check)) return refuse('semctx', 'verdict', 'semantic check reports errors in the candidate model')
    const checkError = semanticCheckError(check, expected)
    if (checkError) return checkError
    const findingError = lifecycleError(check, expected)
    if (findingError) return findingError
    return changeResults(native, expected)
  } catch (error) {
    return refuse('semctx', 'unreadable', errorMessage(error))
  }
}
