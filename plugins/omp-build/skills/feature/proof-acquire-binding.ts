import { isMap } from './proof-base'

export type BindingMandate = {
  scope: { repository: string; target: string }
  recordId: string
  kind: 'mandate'
  branch: string
  base: string
}

export function bindingOf(record: { kind: string; payload: unknown }): BindingMandate | 'malformed' | null {
  if (record.kind !== 'workflow-binding') return null
  const payload = record.payload
  if (!isMap(payload)) return 'malformed'
  const mandate = payload.mandate
  if (
    !isMap(mandate) ||
    mandate.kind !== 'mandate' ||
    typeof mandate.recordId !== 'string' ||
    !isMap(mandate.scope) ||
    typeof mandate.scope.repository !== 'string' ||
    typeof mandate.scope.target !== 'string' ||
    typeof payload.branch !== 'string' ||
    payload.branch.length === 0 ||
    typeof payload.base !== 'string' ||
    payload.base.length === 0
  ) {
    return 'malformed'
  }
  return {
    scope: { repository: mandate.scope.repository, target: mandate.scope.target },
    recordId: mandate.recordId,
    kind: 'mandate',
    branch: payload.branch,
    base: payload.base,
  }
}

export function parseArgs(argv: string[]): { pr: number; manifest?: string } | null {
  let pr: number | undefined
  let manifest: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (value === undefined) return null
    if (flag === '--pr' && /^[1-9]\d*$/.test(value)) pr = Number(value)
    else if (flag === '--assertledger-manifest' && value) manifest = value
    else return null
    i++
  }
  return pr === undefined ? null : { pr, manifest }
}
