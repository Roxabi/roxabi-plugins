import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Spelling sweep for `skill://` in shell contexts (#619).
 *
 * The sweep allows a URL only when it appears in this assignment grammar:
 *
 *   NAME=$(realpath [-flags] ['']?skill://…['']?) && …
 *   NAME=$(realpath …) || { …; exit N; }   # N ≥ 1; block may span lines
 *   NAME="$(realpath …)" && … / || { … exit N; }
 *
 * Any other `realpath` / `read` / `cat` / `bun` / `bash` / … + `skill://` in a
 * scanned shell context is a hit — including `;`, a bare newline, inline
 * `"$(realpath …)"`, `|| { …; }` with no exit, and `cat … | <shell>`.
 *
 * This is a spelling allowlist, not a control-flow proof. Fail-closed behaviour
 * is proven by the executed sites: Filing, promote 9d, step 7, and the printed
 * `next:` line — not by this sweep. Remaining spelling gaps go to a follow-up.
 *
 * Corpus: every `.md` under plugins/.
 */

const REPO = path.resolve(import.meta.dirname, '../../..')
const PLUGINS = path.join(REPO, 'plugins')

/** Languages that are never shell, even when the fence body looks shellish. */
const NON_SHELL_LANG: Record<string, true> = {
  js: true,
  javascript: true,
  ts: true,
  typescript: true,
  tsx: true,
  jsx: true,
  json: true,
  yaml: true,
  yml: true,
  md: true,
  markdown: true,
  text: true,
  txt: true,
  diff: true,
  html: true,
  css: true,
  toml: true,
  xml: true,
  svg: true,
  py: true,
  python: true,
  go: true,
  rust: true,
  java: true,
  c: true,
  cpp: true,
  h: true,
  rb: true,
  ruby: true,
  sql: true,
  graphql: true,
  proto: true,
  dockerfile: true,
  makefile: true,
  ini: true,
  cfg: true,
}

/** Whole-word shell commands — hyphenated `read-*` / `node-*` must not match. */
const CMD = `(?:bun|bash|node|sh|bunx|npx|realpath|read|cat)`
const CMD_RE = new RegExp(String.raw`(?<![-\w])${CMD}(?![-\w])`)

/** A resolvable skill path — requires a skill name (skips `skill://…` ellipses). */
const SKILL_URL = /skill:\/\/[a-zA-Z0-9][\w./-]*/g

function walk(dir: string, match: (rel: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry)
    if (statSync(abs).isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue
      out.push(...walk(abs, match))
      continue
    }
    const rel = path.relative(REPO, abs).split(path.sep).join('/')
    if (match(rel)) out.push(rel)
  }
  return out
}

/** Join `\\\n` continuations so option+value and argv spans are one line. */
function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n/g, ' ')
}

/** Drop `# …` comment lines (and trailing `# …` on a line) before scanning. */
function stripShellComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) return ''
      const match = /^(?<code>(?:[^'"#]|'[^']*'|"[^"]*")*?)\s#(?<rest>.*)$/.exec(line)
      return match?.groups?.code ?? line
    })
    .join('\n')
}

/**
 * Fail-closed realpath assignment. Captures each allowed `skill://` span so the
 * scanner can skip exactly those occurrences.
 *
 * NAME=$(realpath [-e …] ['']?skill://…['']?) && …
 * NAME="$(realpath …)" || { … exit N; }   with N ≥ 1
 */
const FAIL_CLOSED =
  /\b[A-Za-z_][A-Za-z0-9_]*=(?:"\$\(\s*realpath\b[^)]*\)"|\$\(\s*realpath\b[^)]*\))\s*(?:&&|\|\|\s*\{(?:(?!\})[\s\S])*?\bexit\s+(?:[1-9]\d*)\b(?:(?!\})[\s\S])*?\})/g

function allowedSkillRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  for (const match of text.matchAll(FAIL_CLOSED)) {
    const statement = match[0]
    const absolute = match.index ?? 0
    for (const url of statement.matchAll(SKILL_URL)) {
      const local = url.index ?? 0
      const headEnd = statement.search(/\)\s*(?:&&|\|\|)/)
      if (headEnd >= 0 && local > headEnd) continue
      ranges.push({ start: absolute + local, end: absolute + local + url[0].length })
    }
  }
  return ranges
}

function inRange(ranges: Array<{ start: number; end: number }>, index: number): boolean {
  return ranges.some((range) => index >= range.start && index < range.end)
}

/** `](skill://…)` markdown link targets are not shell argv. */
function inMarkdownLink(text: string, index: number): boolean {
  return text.slice(Math.max(0, index - 2), index) === ']('
}

type TextRange = { start: number; end: number }

type LineCursor = { index: number; offset: number }

function addShellContext(contexts: string[], body: string, language?: string): void {
  if (language !== undefined && Object.hasOwn(NON_SHELL_LANG, language)) return
  SKILL_URL.lastIndex = 0
  if (!SKILL_URL.test(body)) return
  SKILL_URL.lastIndex = 0
  contexts.push(joinContinuations(stripShellComments(body)))
}

function readFence(
  lines: string[],
  cursor: LineCursor,
  open: RegExpExecArray,
): {
  body: string
  language: string
  range: TextRange
} {
  const marker = open[2][0]
  const markerLength = open[2].length
  const language = (open[3].trim().split(/\s+/)[0] ?? '').toLowerCase()
  const start = cursor.offset
  const body: string[] = []
  cursor.offset += lines[cursor.index].length + 1
  cursor.index += 1
  const close = new RegExp(`^ {0,3}${marker}{${markerLength},}\\s*$`)
  while (cursor.index < lines.length) {
    const line = lines[cursor.index]
    cursor.offset += line.length + 1
    cursor.index += 1
    if (close.test(line)) break
    body.push(line)
  }
  return { body: body.join('\n'), language, range: { start, end: cursor.offset } }
}

function fencedContexts(lines: string[]): { contexts: string[]; consumed: TextRange[] } {
  const contexts: string[] = []
  const consumed: TextRange[] = []
  const cursor: LineCursor = { index: 0, offset: 0 }
  while (cursor.index < lines.length) {
    const line = lines[cursor.index]
    const open = /^( {0,3})([`~]{3,})(.*)$/.exec(line)
    if (open === null) {
      cursor.offset += line.length + 1
      cursor.index += 1
      continue
    }
    const fence = readFence(lines, cursor, open)
    consumed.push(fence.range)
    addShellContext(contexts, fence.body, fence.language)
  }
  return { contexts, consumed }
}

function inConsumedRange(consumed: TextRange[], offset: number): boolean {
  return consumed.some((range) => offset >= range.start && offset < range.end)
}

function isIndentedOrBlank(line: string): boolean {
  return /^(?: {4}|\t)/.test(line) || line.trim() === ''
}

function readIndentedBlock(
  lines: string[],
  cursor: LineCursor,
  consumed: TextRange[],
): {
  body: string
  range: TextRange
} {
  const start = cursor.offset
  const body: string[] = []
  while (cursor.index < lines.length) {
    const line = lines[cursor.index]
    if (inConsumedRange(consumed, cursor.offset) || !isIndentedOrBlank(line)) break
    body.push(line.replace(/^(?: {4}|\t)/, ''))
    cursor.offset += line.length + 1
    cursor.index += 1
  }
  return { body: body.join('\n'), range: { start, end: cursor.offset } }
}

function collectIndentedContexts(lines: string[], contexts: string[], consumed: TextRange[]): void {
  const cursor: LineCursor = { index: 0, offset: 0 }
  while (cursor.index < lines.length) {
    const line = lines[cursor.index]
    if (inConsumedRange(consumed, cursor.offset) || !/^(?: {4}|\t)/.test(line)) {
      cursor.offset += line.length + 1
      cursor.index += 1
      continue
    }
    const block = readIndentedBlock(lines, cursor, consumed)
    consumed.push(block.range)
    addShellContext(contexts, block.body)
  }
}

function withoutConsumed(markdown: string, consumed: TextRange[]): string {
  const chars = [...markdown]
  for (const range of consumed) {
    for (let index = range.start; index < range.end && index < chars.length; index += 1) {
      if (chars[index] !== '\n') chars[index] = ' '
    }
  }
  return chars.join('')
}

function collectInlineContexts(markdown: string, contexts: string[]): void {
  const matches = [...markdown.matchAll(/`([^`]+)`/g)]
  let start = 0
  while (start < matches.length) {
    let end = start
    while (end + 1 < matches.length) {
      const previous = matches[end]
      const next = matches[end + 1]
      const previousEnd = (previous.index ?? 0) + previous[0].length
      if (!/^[ \t]*\n?[ \t]*$/.test(markdown.slice(previousEnd, next.index ?? 0))) break
      end += 1
    }
    const joined = matches
      .slice(start, end + 1)
      .map((match) => match[1].replace(/[ \t]*\r?\n[ \t]*/g, ' '))
      .join(' ')
    addShellContext(contexts, joined)
    start = end + 1
  }
}

/**
 * Shell contexts: every fence spelling (``` / ~~~ / 4+ / titled / console) unless
 * the language is known non-shell; indented code blocks; inline spans (joined
 * across soft line breaks within a paragraph).
 */
function shellContexts(markdown: string): string[] {
  const lines = markdown.split('\n')
  const { contexts, consumed } = fencedContexts(lines)
  collectIndentedContexts(lines, contexts, consumed)
  collectInlineContexts(withoutConsumed(markdown, consumed), contexts)
  return contexts
}

/**
 * Hits: every resolvable `skill://` in a shell fragment that is not inside a
 * fail-closed realpath assignment (and not a citation / link / printf message).
 */
function skillArgvHits(fragment: string): string[] {
  const hits: string[] = []
  const text = joinContinuations(stripShellComments(fragment))
  const allowed = allowedSkillRanges(text)

  SKILL_URL.lastIndex = 0
  for (const match of text.matchAll(SKILL_URL)) {
    const index = match.index ?? 0
    if (inMarkdownLink(text, index) || inRange(allowed, index)) continue
    const boundary = Math.max(
      text.lastIndexOf('\n', index - 1),
      text.lastIndexOf(';', index - 1),
      text.lastIndexOf('&&', index - 1),
      text.lastIndexOf('||', index - 1),
      text.lastIndexOf('|', index - 1),
    )
    const local = text.slice(boundary + 1, index)
    if (/\b(?:printf|echo)\b\s+['"][^'"]*$/.test(local)) continue
    if (!CMD_RE.test(local)) continue
    hits.push(text.slice(Math.max(0, index - 32), index + match[0].length + 16).trim())
  }
  return hits
}

describe('external programs never take bare skill:// argv', () => {
  const corpus = walk(PLUGINS, (relative) => relative.endsWith('.md'))

  it('scans every markdown file under plugins/', () => {
    expect(corpus.some((file) => file.endsWith('/SKILL.md'))).toBe(true)
    expect(corpus.some((file) => file.includes('/templates/') && file.endsWith('.md'))).toBe(true)
    expect(corpus.some((file) => file.endsWith('/README.md'))).toBe(true)
    expect(corpus.some((file) => file.startsWith('plugins/omp-build/'))).toBe(true)
    expect(corpus.some((file) => file.startsWith('plugins/issue-triage/'))).toBe(true)
  })

  it('finds no unsafe skill:// in shell contexts across the corpus', () => {
    const hits: string[] = []
    for (const relative of corpus) {
      const text = readFileSync(path.join(REPO, relative), 'utf8')
      for (const context of shellContexts(text)) {
        for (const hit of skillArgvHits(context)) hits.push(`${relative}: ${hit}`)
      }
    }
    expect(hits).toEqual([])
  })
})

describe('skillArgvHits allowlist shapes', () => {
  it('allows NAME=$(realpath) && …', () => {
    expect(skillArgvHits('T=$(realpath skill://issue-triage/triage.ts) && bun "$T" init')).toEqual([])
  })

  it('allows NAME=$(realpath -e) || { exit N; } spanning lines', () => {
    expect(
      skillArgvHits(`T=$(realpath -e skill://promote/lib/finalize.ts) || {
  printf 'REFUSE: cannot resolve skill://promote/lib/finalize.ts\\n'
  exit 1
}`),
    ).toEqual([])
  })

  it('allows NAME="$(realpath …)" && …', () => {
    expect(skillArgvHits('T="$(realpath skill://ci-watch/ci-watch.sh)" && bash "$T"')).toEqual([])
  })

  it('allows quoted URL inside fail-closed && form', () => {
    expect(skillArgvHits('T=$(realpath "skill://issue-triage/triage.ts") && bun "$T" init')).toEqual([])
  })
})

describe('skillArgvHits fail-open variants (S7–S12, X1, newline, cat|bash)', () => {
  it('S7: quoted semicolon form', () => {
    expect(skillArgvHits('T="$(realpath skill://issue-triage/triage.ts)"; bun "$T" init')).not.toEqual([])
  })

  it('S8: quoted URL with semicolon', () => {
    expect(skillArgvHits('T=$(realpath "skill://issue-triage/triage.ts"); bun "$T" init')).not.toEqual([])
  })

  it('S9: quoted inline realpath-as-argv', () => {
    expect(skillArgvHits('bun "$(realpath "skill://issue-triage/triage.ts")" init')).not.toEqual([])
    expect(skillArgvHits('bun "$(realpath skill://issue-triage/triage.ts)" init')).not.toEqual([])
  })

  it('S10: unquoted inline realpath-as-argv', () => {
    expect(skillArgvHits('bun $(realpath skill://issue-triage/triage.ts) init')).not.toEqual([])
  })

  it('S12: || { … } with no exit', () => {
    expect(
      skillArgvHits(`T=$(realpath skill://promote/lib/finalize.ts) || {
  printf 'REFUSE\\n'
}`),
    ).not.toEqual([])
  })

  it('X1: soft-wrapped bare form joined across two spans', () => {
    const markdown = 'Run\n`bun`\n`skill://issue-triage/triage.ts init`\nnow.\n'
    const contexts = shellContexts(markdown)
    expect(contexts.some((context) => /bun.*skill:\/\//.test(context))).toBe(true)
    expect(contexts.some((context) => skillArgvHits(context).length > 0)).toBe(true)
  })

  it('X1 one-span: soft-wrapped bare form inside a single code span', () => {
    const markdown = 'Run `bun\n  skill://issue-triage/triage.ts init` now.\n'
    const contexts = shellContexts(markdown)
    expect(contexts.some((context) => /bun skill:\/\//.test(context))).toBe(true)
    expect(contexts.some((context) => skillArgvHits(context).length > 0)).toBe(true)
  })

  it('newline instead of ; or &&', () => {
    expect(
      skillArgvHits(`T=$(realpath skill://issue-triage/triage.ts)
bun "$T" init`),
    ).not.toEqual([])
  })

  it('cat skill:// | bash', () => {
    expect(skillArgvHits('cat skill://ci-watch/ci-watch.sh | bash -s')).not.toEqual([])
  })

  it('bare bun / option+value / env-prefix / continuation', () => {
    expect(skillArgvHits("bun 'skill://issue-triage/triage.ts' init")).not.toEqual([])
    expect(skillArgvHits('bash -o pipefail skill://cleanup/gather-state.sh')).not.toEqual([])
    expect(skillArgvHits('GITHUB_REPO=acme/x bun skill://issue-triage/triage.ts init')).not.toEqual([])
    expect(
      skillArgvHits(`bash \\
  skill://cleanup/gather-state.sh`),
    ).not.toEqual([])
  })
})

describe('shellContexts fence spellings', () => {
  it('scans ~~~ / 4-backtick / titled / console fences', () => {
    const markdown = `
~~~
bun skill://issue-triage/triage.ts init
~~~

\`\`\`\`bash
bun skill://issue-triage/triage.ts init
\`\`\`\`

\`\`\`bash title="run"
bun skill://issue-triage/triage.ts init
\`\`\`

\`\`\`console
bun skill://issue-triage/triage.ts init
\`\`\`
`
    const contexts = shellContexts(markdown)
    expect(contexts.length).toBeGreaterThanOrEqual(4)
    for (const context of contexts) expect(skillArgvHits(context).length).toBeGreaterThan(0)
  })

  it('scans indented code blocks', () => {
    const markdown = `
Here is an indented block:

    bun skill://issue-triage/triage.ts init

Done.
`
    const contexts = shellContexts(markdown)
    expect(contexts.some((context) => skillArgvHits(context).length > 0)).toBe(true)
  })

  it('skips known non-shell fences', () => {
    const markdown = '```ts\nconst x = "skill://issue-triage/triage.ts"\n```\n'
    expect(shellContexts(markdown)).toEqual([])
  })
})

describe('false positives stay clean', () => {
  it('citation span with no command word', () => {
    expect(skillArgvHits('skill://ci-watch/ci-watch.sh')).toEqual([])
    expect(
      shellContexts('See `skill://ci-watch/ci-watch.sh` for the path.').every(
        (context) => skillArgvHits(context).length === 0,
      ),
    ).toBe(true)
  })

  it('# comment lines inside fences', () => {
    expect(
      skillArgvHits(`# bun skill://issue-triage/triage.ts init
T=$(realpath skill://issue-triage/triage.ts) && bun "$T" init`),
    ).toEqual([])
  })

  it('hyphenated read-* / node-* names', () => {
    expect(skillArgvHits('read-file skill://dev-review/root-causes.md')).toEqual([])
    expect(skillArgvHits('node-modules skill://issue-triage/triage.ts')).toEqual([])
  })

  it('markdown links', () => {
    expect(skillArgvHits('see [x](skill://promote/price.sh) for pricing')).toEqual([])
  })

  it('ellipsis anti-pattern docs are not resolvable skill URLs', () => {
    expect(skillArgvHits('cat skill://… | bash -s')).toEqual([])
  })

  it('wrapped fail-closed span stays clean', () => {
    const markdown = 'Run `T=$(realpath skill://issue-triage/triage.ts) &&\n  bun "$T" init` now.\n'
    expect(shellContexts(markdown).every((context) => skillArgvHits(context).length === 0)).toBe(true)
  })
})
