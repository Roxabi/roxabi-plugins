function wrapLine(line: string, width: number): string[] {
  const rows: string[] = []
  let current = ''
  let cells = 0
  for (const char of line) {
    const code = char.codePointAt(0) ?? 0
    if (code < 32 || (code >= 127 && code <= 159)) continue
    const size = code < 128 ? 1 : 2
    if (cells + size > width) {
      rows.push(current)
      current = ''
      cells = 0
    }
    current += char
    cells += size
  }
  rows.push(current)
  return rows
}

function footerRows(width: number, selected: number): string[] {
  const footer = [
    `${selected === 0 ? '>' : ' '}[C] Confirmer`,
    `${selected === 1 ? '>' : ' '}[R] Refuser`,
    `${selected === 2 ? '>' : ' '}[Esc] Plus tard`,
    ' [D] Détails',
  ]
  const rows: string[] = []
  for (const item of footer) {
    const last = rows.length - 1
    const previous = rows[last]
    if (previous !== undefined && previous.length + item.length + 1 <= width) rows[last] = `${previous} ${item}`
    else rows.push(item)
  }
  return rows
}

function tooSmall(width: number, height: number) {
  const lines = ['Trop petit', 'Esc: Plus tard'].flatMap((line) => wrapLine(line, Math.max(1, width)))
  return { lines: lines.slice(0, Math.max(0, height)), offset: 0, maxOffset: 0, actionable: false }
}

export function operatorDialogLayout(
  width: number,
  height: number,
  selected: number,
  offset: number,
  text: readonly string[],
): { lines: string[]; offset: number; maxOffset: number; actionable: boolean } {
  if (width < 20 || height < 5) return tooSmall(width, height)
  const footer = footerRows(width, selected)
  const bodyHeight = Math.max(0, height - footer.length - 1)
  if (bodyHeight < 1) return tooSmall(width, height)
  const body = text.flatMap((entry) => entry.split('\n').flatMap((line) => wrapLine(line, width - 2)))
  const maxOffset = Math.max(0, body.length - bodyHeight)
  const position = Math.min(offset, maxOffset)
  const visible = body.slice(position, position + bodyHeight)
  while (visible.length < bodyHeight) visible.push('')
  return {
    lines: ['Proposition à examiner', ...visible, ...footer],
    offset: position,
    maxOffset,
    actionable: bodyHeight >= 1,
  }
}
