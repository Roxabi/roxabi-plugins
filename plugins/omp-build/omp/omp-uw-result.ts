import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { OmpBuildExtensionApi } from './omp-controller.ts'

function text(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (item instanceof Map ? [...item.entries()] : item), 2) ?? 'null'
}

function object(value: unknown): object | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function property(value: object | null | undefined, key: string): unknown {
  return value !== null && value !== undefined && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function scope(value: unknown): string | null {
  const record = object(value)
  const repository = string(property(record, 'repository'))
  const target = string(property(record, 'target'))
  return repository === null || target === null
    ? null
    : target.startsWith(`${repository}#`)
      ? target
      : `${repository}:${target}`
}

function diagnosticCodes(value: unknown): readonly string[] {
  const diagnostics = property(object(value), 'diagnostics')
  return !Array.isArray(diagnostics)
    ? []
    : diagnostics.flatMap((diagnostic) => {
        const code = string(property(object(diagnostic), 'code'))
        return code === null ? [] : [code]
      })
}

function readSummary(value: object): string {
  const proposed = object(property(value, 'proposed'))
  const proposalSnapshot = property(proposed, 'ok') === true ? object(property(proposed, 'snapshot')) : null
  const proposalSpec = object(property(proposalSnapshot, 'spec'))
  const accepted = object(property(value, 'accepted'))
  const acceptedValue = property(accepted, 'status') === 'accepted' ? object(property(accepted, 'value')) : null
  const acceptedRef = object(property(acceptedValue, 'ref'))
  const proposedVersion = string(property(proposalSpec, 'version')) ?? 'unavailable'
  const acceptedVersion =
    string(property(acceptedRef, 'version')) ?? string(property(accepted, 'status')) ?? 'unavailable'
  const blocked = [
    ...diagnosticCodes(property(object(property(value, 'admission')), 'framed')),
    ...diagnosticCodes(property(object(property(value, 'admission')), 'deliverable')),
    ...diagnosticCodes(proposed),
    ...diagnosticCodes(accepted),
  ]
  const details = blocked.length === 0 ? '' : ` diagnostics=${[...new Set(blocked)].join(',')}`
  return `uw-read: ${scope(property(value, 'uw')) ?? 'unknown'} proposed=${proposedVersion} accepted=${acceptedVersion}${details}`
}

function statusSummary(record: object, status: string, resultValue: object | null): string {
  const disposition = status === 'adjudicated' ? object(property(record, 'disposition')) : null
  const target =
    scope(property(record, 'uw')) ?? scope(property(resultValue, 'uw')) ?? scope(property(disposition, 'scope'))
  const diagnostics = diagnosticCodes(record)
  const suffix = diagnostics.length === 0 ? '' : ` diagnostics=${diagnostics.join(',')}`
  return `uw-${status}: ${target ?? 'no-trustworthy-uw'}${suffix}`
}

function successSummary(resultValue: object): string {
  const reports = property(resultValue, 'reports')
  if (Array.isArray(reports))
    return `uw-reports: ${scope(property(resultValue, 'root')) ?? 'unknown'} count=${reports.length}`
  const proposal = object(property(resultValue, 'proposal'))
  const target = object(property(proposal, 'target'))
  const uw = scope(property(target, 'uw')) ?? string(property(target, 'repository')) ?? 'unknown'
  const allocation = object(property(proposal, 'allocation'))
  const spec = object(property(allocation, 'spec'))
  const version = string(property(spec, 'version')) ?? 'unavailable'
  return `uw-prepared: ${uw} proposed=${version}`
}

function resultSummary(value: unknown): string {
  if (Array.isArray(value)) return `uw-result: success count=${value.length}`
  const record = object(value)
  if (record === null) return 'uw-result: malformed-result'
  if (Object.hasOwn(record, 'uw') && Object.hasOwn(record, 'parsed')) return readSummary(record)
  const status = string(property(record, 'status'))
  const resultValue = object(property(record, 'value'))
  if (status !== null) return statusSummary(record, status, resultValue)
  if (property(record, 'ok') === true && resultValue !== null) return successSummary(resultValue)
  const diagnostics = diagnosticCodes(record)
  return `uw-refused: ${diagnostics.length === 0 ? 'unspecified' : diagnostics.join(',')}`
}

function writeSessionResultArtifact(ctx: ExtensionContext, value: unknown): string | null {
  const directory = ctx.localProtocolOptions?.getArtifactsDir?.()
  if (directory === undefined || directory === null) return null
  try {
    mkdirSync(directory, { recursive: true })
    const last = readdirSync(directory).reduce((maximum, file) => {
      const match = /^(\d+)\./.exec(file)
      const id = match === null ? null : Number(match[1])
      return id === null || !Number.isSafeInteger(id) ? maximum : Math.max(maximum, id)
    }, -1)
    for (let id = last + 1; id <= last + 100; id += 1) {
      const path = resolve(directory, `${id}.uw-result.json`)
      try {
        writeFileSync(path, text(value), { flag: 'wx' })
        return path
      } catch (error) {
        if (string(property(object(error), 'code')) !== 'EEXIST') return null
      }
    }
  } catch {
    return null
  }
  return null
}

export function reportResult(pi: OmpBuildExtensionApi, ctx: ExtensionContext, value: unknown): void {
  const path = writeSessionResultArtifact(ctx, value)
  const detail =
    path === null ? 'detail=unavailable' : `detail=${path} owner=session-artifacts lifetime=session-retention`
  pi.sendMessage(`${resultSummary(value)} ${detail}`, { triggerTurn: false })
}
