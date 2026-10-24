function stripInlineComment(line: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      out += c
      if (c === quote && line[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out += c
      continue
    }
    if (c === '#') break
    out += c
  }
  return out.trimEnd()
}

function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

function lineIndent(line: string): number {
  const m = line.match(/^[ ]*/)
  return m ? m[0].length : 0
}

type YamlLine = { indent: number; key: string; value: string }

export function parseYamlLines(text: string): YamlLine[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\t/g, '  ')
  const rows: YamlLine[] = []
  for (const raw of normalized.split('\n')) {
    const stripped = stripInlineComment(raw)
    if (!stripped.trim()) continue
    const indent = lineIndent(stripped)
    const content = stripped.trim()
    const colon = content.indexOf(':')
    if (colon < 0) continue
    const key = content.slice(0, colon).trim()
    const value = unquote(content.slice(colon + 1))
    if (!key) continue
    rows.push({ indent, key, value })
  }
  return rows
}

export function blockEnd(lines: YamlLine[], startIdx: number): number {
  const base = lines[startIdx].indent
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].indent <= base) return i
  }
  return lines.length
}

export function parseInteger(raw: string, fallback: number, name: string, warnings: string[]): number {
  if (!raw) return fallback
  if (!/^-?\d+$/.test(raw)) {
    warnings.push(`${name} is not an integer; using default ${fallback}`)
    return fallback
  }
  return Number(raw)
}
