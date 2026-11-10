import { isRecord } from '../roxabi/feature-engine.ts'

export const PARTIAL = 'Les effets peuvent être partiels ; aucun retour arrière automatique.'

export function summaryField(trustedPrefix: string, rawValue: string): string {
  return `${trustedPrefix}${JSON.stringify(rawValue)}`
}

export function scopeText(scope: unknown): string {
  if (!isRecord(scope)) return ''
  const repository = typeof scope.repository === 'string' ? scope.repository : ''
  const target = typeof scope.target === 'string' ? scope.target : ''
  if (repository && target && !target.includes(repository)) return `${repository} ${target}`
  return target || repository
}

export function refText(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.repository === 'string' && typeof value.number === 'number')
    return `${value.repository}#${value.number}`
  if (typeof value.repository === 'string' || typeof value.target === 'string') return scopeText(value)
  return null
}

export function quoted(lines: string[], prefix: string, value: string): void {
  if (value) lines.push(summaryField(prefix, value))
}

export function strings(lines: string[], prefix: string, value: unknown): void {
  if (!Array.isArray(value)) return
  for (const item of value) if (typeof item === 'string' && item) quoted(lines, prefix, item)
}

export function refs(lines: string[], prefix: string, value: unknown): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    const label = refText(item)
    if (label) quoted(lines, prefix, label)
  }
}

export function asked(prefix: string, scope: string): string {
  return `${summaryField(prefix, scope || 'cible inconnue')} ?`
}

export function unrecognizedWarning(scope: string): string {
  if (!scope) return 'Proposition non reconnue : examiner les Détails avant toute décision.'
  return `${summaryField('Proposition non reconnue pour ', scope)} : examiner les Détails avant toute décision.`
}
