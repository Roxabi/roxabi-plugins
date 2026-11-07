import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import type { ReviewDriver } from './native-review-driver.ts'

const directory = process.env.OMP_PHASE_PROBE_DIR
const counters = new Map<string, { starts: number; completed: number; failed: number; ns: number; bytes: number }>()
let count = 0
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 20)

export function probeScope(state?: string): string {
  return state ? digest(state) : 'unknown'
}

export function probeSerializedState(stateFile: string, state: unknown): string {
  const start = process.hrtime.bigint()
  const raw = JSON.stringify(state, null, 2)
  probeCount(
    probeScope(stateFile),
    'goal-state-serialize',
    'json',
    Number(process.hrtime.bigint() - start),
    Buffer.byteLength(raw),
  )
  return raw
}

export function driverDiagnostic(driver: ReviewDriver | undefined) {
  if (driver === undefined) return null
  const active = driver.controller.active()
  return {
    callbacks: driver.diagnostics,
    messages: driver.messages.map((message) => {
      if (message.includes('OMP_BUILD_NATIVE_BATCH')) return 'OMP_BUILD_NATIVE_BATCH'
      if (message.startsWith('feature-stopped:')) return message
      return message.split(':', 1)[0]
    }),
    active:
      active === null
        ? null
        : {
            operationId: active.operationId,
            tasks: active.tasks.tasks.map((task) => ({
              name: task.name,
              agent: task.agent,
              actionId: task.action.snapshot.actionId,
              fingerprint: task.action.inputs.fingerprint,
              head: task.action.inputs.manifest.code.head,
              refs: task.action.inputs.manifest.deliveryData.map((ref) => ({
                role: ref.role,
                kind: ref.record.kind,
                recordId: ref.record.recordId,
                selector: ref.selector,
              })),
            })),
          },
  }
}

function output(data: object): void {
  if (!directory) return
  try {
    appendFileSync(path.join(directory, `probe-${process.pid}.jsonl`), `${JSON.stringify(data)}\n`, { mode: 0o600 })
  } catch {
    // Diagnostics must not change the observed workflow.
  }
}

export function probePhase(scope: string, phase: string): void {
  if (!directory) return
  output({
    type: 'phase',
    pid: process.pid,
    scope,
    phase,
    monoNs: process.hrtime.bigint().toString(),
    wallMs: Date.now(),
  })
}
export function probeData(scope: string, phase: string, data: Record<string, unknown>): void {
  if (!directory) return
  output({
    type: 'phase',
    pid: process.pid,
    scope,
    phase,
    monoNs: process.hrtime.bigint().toString(),
    wallMs: Date.now(),
    data,
  })
}

export function probeOperation(argv: string[]): string {
  const root = argv[0] ?? ''
  const methodIndex = argv.findIndex((arg) => arg === '-X' || arg === '--method')
  const method = methodIndex >= 0 ? (argv[methodIndex + 1] ?? '').toUpperCase() : 'DEFAULT'
  const endpointIndex = root === 'api' && methodIndex === 1 ? 3 : 1
  const sub = argv[endpointIndex] ?? ''
  const query = argv.find((arg) => arg.startsWith('query='))?.slice(6)
  const endpoint = root === 'api' ? sub : `${root}/${sub}`
  return `${root === 'api' && sub === 'graphql' ? 'graphql' : 'command'}:${method}:${digest(endpoint)}:${query ? digest(query.replace(/\s+/g, ' ').trim()) : '-'}`
}

export function probeStart(scope: string, kind: string, operation: string): void {
  if (!directory) return
  const key = JSON.stringify([scope, kind, operation])
  const value = counters.get(key) ?? { starts: 0, completed: 0, failed: 0, ns: 0, bytes: 0 }
  value.starts++
  counters.set(key, value)
}

export function probeCount(
  scope: string,
  kind: string,
  operation: string,
  ns: number,
  bytes = 0,
  failed = false,
  started = false,
): void {
  if (!directory) return
  const key = JSON.stringify([scope, kind, operation])
  const value = counters.get(key) ?? { starts: 0, completed: 0, failed: 0, ns: 0, bytes: 0 }
  value.completed++
  if (!started) value.starts++
  value.failed += Number(failed)
  value.ns += ns
  value.bytes += bytes
  counters.set(key, value)
  if (++count >= 100) flushProbe()
}

export function flushProbe(): void {
  if (!directory || counters.size === 0) return
  output({
    type: 'counts',
    pid: process.pid,
    monoNs: process.hrtime.bigint().toString(),
    wallMs: Date.now(),
    rows: [...counters].map(([key, value]) => ({ key: JSON.parse(key), ...value })),
  })
  counters.clear()
  count = 0
}
if (directory) process.on('exit', flushProbe)
