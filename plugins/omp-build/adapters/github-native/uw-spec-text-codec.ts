export const ITEM_CONTINUATION_PREFIX = '  '

const TEXT_ENCODING = /^\s*(~{3,})omp-build-text\s*$/

export function encodeSpecText(value: string): string {
  const longest = [...value.matchAll(/~+/g)].reduce((count, match) => Math.max(count, (match[0] ?? '').length), 0)
  const delimiter = '~'.repeat(Math.max(3, longest + 1))
  return `${delimiter}omp-build-text\n${value}\n${delimiter}`
}

export function decodeSpecText(value: string): string | null {
  const lines = value.replace(/\r\n?/g, '\n').split('\n')
  const opening = TEXT_ENCODING.exec(lines[0] ?? '')
  const delimiter = opening?.[1]
  if (delimiter === undefined || lines.at(-1) !== delimiter) return null
  const closes = new RegExp(`^\\s*${delimiter}\\s*$`)
  if (lines.slice(1, -1).some((line) => closes.test(line))) return null
  return lines.slice(1, -1).join('\n')
}

export function isSpecTextFence(value: string): boolean {
  return TEXT_ENCODING.test(value.replace(/\r\n?/g, '\n').split('\n')[0] ?? '')
}

export function formatItemBody(statement: string): string {
  const lines = statement.split('\n')
  if (lines.length <= 1) return statement
  return [lines[0], ...lines.slice(1).map((line) => `${ITEM_CONTINUATION_PREFIX}${line}`)].join('\n')
}

export function decodeContinuationLines(lines: readonly string[]): string {
  return lines
    .map((line) => (line.startsWith(ITEM_CONTINUATION_PREFIX) ? line.slice(ITEM_CONTINUATION_PREFIX.length) : line))
    .join('\n')
}
