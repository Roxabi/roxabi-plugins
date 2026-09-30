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

const REPO = path.resolve(import.meta.dirname, '../../../..')
const PLUGINS = path.join(REPO, 'plugins')

/** Languages that are never shell, even when the fence body looks shellish. */
const NON_SHELL_LANG = new Set([
  'js',
  'javascript',
  'ts',
  'typescript',
  'tsx',
  'jsx',
  'json',
  'yaml',
  'yml',
  'md',
  'markdown',
  'text',
  'txt',
  'diff',
  'html',
  'css',
  'toml',
  'xml',
  'svg',
  'py',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'h',
  'rb',
  'ruby',
  'sql',
  'graphql',
  'proto',
  'dockerfile',
  'makefile',
  'ini',
  'cfg',
])

/** Whole-word shell commands — hyphenated `read-*` / `node-*` must not match. */
const CMD = String.raw`(?:bun|bash|node|sh|bunx|npx|realpath|read|cat)`
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
export function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n/g, ' ')
}

/** Drop `# …` comment lines (and trailing `# …` on a line) before scanning. */
export function stripShellComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) return ''
      // Trailing comment — keep quoted `#` alone by only stripping when space-#.
      const m = /^(?<code>(?:[^'"#]|'[^']*'|"[^"]*")*?)\s#(?<rest>.*)$/.exec(line)
      return m?.groups?.code ?? line
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
  for (const m of text.matchAll(FAIL_CLOSED)) {
    const stmt = m[0]
    const abs = m.index ?? 0
    for (const u of stmt.matchAll(SKILL_URL)) {
      const local = u.index ?? 0
      // Only the realpath argument counts — skip URLs inside the ||{ printf } message
      // by requiring they sit inside the $(realpath …) head.
      const headEnd = stmt.search(/\)\s*(?:&&|\|\|)/)
      if (headEnd >= 0 && local > headEnd) continue
      ranges.push({ start: abs + local, end: abs + local + u[0].length })
    }
  }
  return ranges
}

function inRange(ranges: Array<{ start: number; end: number }>, index: number): boolean {
  return ranges.some((r) => index >= r.start && index < r.end)
}

/** `](skill://…)` markdown link targets are not shell argv. */
function inMarkdownLink(text: string, index: number): boolean {
  return text.slice(Math.max(0, index - 2), index) === ']('
}

/**
 * Shell contexts: every fence spelling (``` / ~~~ / 4+ / titled / console) unless
 * the language is known non-shell; indented code blocks; inline spans (joined
 * across soft line breaks within a paragraph).
 */
export function shellContexts(md: string): string[] {
  const out: string[] = []
  const consumed: Array<{ start: number; end: number }> = []

  // Fenced blocks: ``` or ~~~ of any length ≥ 3.
  const lines = md.split('\n')
  let i = 0
  let offset = 0
  while (i < lines.length) {
    const line = lines[i]
    const open = /^( {0,3})([`~]{3,})(.*)$/.exec(line)
    if (!open) {
      offset += line.length + 1
      i++
      continue
    }
    const tick = open[2][0]
    const minLen = open[2].length
    const info = open[3].trim()
    const lang = (info.split(/\s+/)[0] ?? '').toLowerCase()
    const bodyLines: string[] = []
    const start = offset
    offset += line.length + 1
    i++
    while (i < lines.length) {
      const close = new RegExp(`^ {0,3}${tick}{${minLen},}\\s*$`).exec(lines[i])
      if (close) {
        offset += lines[i].length + 1
        i++
        break
      }
      bodyLines.push(lines[i])
      offset += lines[i].length + 1
      i++
    }
    consumed.push({ start, end: offset })
    const body = bodyLines.join('\n')
    if (!NON_SHELL_LANG.has(lang) && SKILL_URL.test(body)) {
      SKILL_URL.lastIndex = 0
      out.push(joinContinuations(stripShellComments(body)))
    }
  }

  // Indented code blocks (4 spaces or a tab), outside fences.
  {
    let j = 0
    let off = 0
    while (j < lines.length) {
      const inFence = consumed.some((r) => off >= r.start && off < r.end)
      if (inFence || !/^(?: {4}|\t)/.test(lines[j])) {
        off += lines[j].length + 1
        j++
        continue
      }
      const block: string[] = []
      const start = off
      while (j < lines.length && (/^(?: {4}|\t)/.test(lines[j]) || lines[j].trim() === '')) {
        if (consumed.some((r) => off >= r.start && off < r.end)) break
        block.push(lines[j].replace(/^(?: {4}|\t)/, ''))
        off += lines[j].length + 1
        j++
      }
      consumed.push({ start, end: off })
      const body = block.join('\n')
      if (SKILL_URL.test(body)) {
        SKILL_URL.lastIndex = 0
        out.push(joinContinuations(stripShellComments(body)))
      }
    }
  }

  // Blank out consumed fence/indent regions so their interiors are not re-read.
  const chars = [...md]
  for (const r of consumed) {
    for (let k = r.start; k < r.end && k < chars.length; k++) {
      if (chars[k] !== '\n') chars[k] = ' '
    }
  }
  const remainder = chars.join('')

  // Inline spans. Chains of spans separated only by whitespace / a soft line
  // break (no other tokens) are joined — that is the soft-wrap split of one
  // command across two spans. Spans separated by prose stay separate so a
  // fail-closed form in one cell cannot absorb a citation in the next.
  const spanRe = /`([^`]+)`/g
  const matches = [...remainder.matchAll(spanRe)]
  let s = 0
  while (s < matches.length) {
    let e = s
    while (e + 1 < matches.length) {
      const prev = matches[e]
      const next = matches[e + 1]
      const prevEnd = (prev.index ?? 0) + prev[0].length
      const between = remainder.slice(prevEnd, next.index ?? 0)
      if (!/^[ \t]*\n?[ \t]*$/.test(between)) break
      e++
    }
    // CommonMark: a soft line break inside one span is a single space.
    const joined = matches
      .slice(s, e + 1)
      .map((m) => m[1].replace(/[ \t]*\r?\n[ \t]*/g, ' '))
      .join(' ')
    if (SKILL_URL.test(joined)) {
      SKILL_URL.lastIndex = 0
      out.push(joinContinuations(joined))
    }
    s = e + 1
  }

  return out
}

/**
 * Hits: every resolvable `skill://` in a shell fragment that is not inside a
 * fail-closed realpath assignment (and not a citation / link / printf message).
 */
export function skillArgvHits(fragment: string): string[] {
  const hits: string[] = []
  const text = joinContinuations(stripShellComments(fragment))
  const allowed = allowedSkillRanges(text)

  SKILL_URL.lastIndex = 0
  for (const m of text.matchAll(SKILL_URL)) {
    const i = m.index ?? 0
    if (inMarkdownLink(text, i)) continue
    if (inRange(allowed, i)) continue

    const boundary = Math.max(
      text.lastIndexOf('\n', i - 1),
      text.lastIndexOf(';', i - 1),
      text.lastIndexOf('&&', i - 1),
      text.lastIndexOf('||', i - 1),
      text.lastIndexOf('|', i - 1),
    )
    const local = text.slice(boundary + 1, i)

    // printf/echo messages may name the URL.
    if (/\b(?:printf|echo)\b\s+['"][^'"]*$/.test(local)) continue

    // Citation: no whole-word shell command before the URL in this statement.
    if (!CMD_RE.test(local)) continue

    hits.push(text.slice(Math.max(0, i - 32), i + m[0].length + 16).trim())
  }
  return hits
}

describe('external programs never take bare skill:// argv', () => {
  const corpus = walk(PLUGINS, (rel) => rel.endsWith('.md'))

  it('scans every markdown file under plugins/', () => {
    expect(corpus.some((f) => f.endsWith('/SKILL.md'))).toBe(true)
    expect(corpus.some((f) => f.includes('/templates/') && f.endsWith('.md'))).toBe(true)
    expect(corpus.some((f) => f.endsWith('/README.md'))).toBe(true)
    expect(corpus.length).toBeGreaterThan(80)
  })

  it('finds no unsafe skill:// in shell contexts across the corpus', () => {
    const hits: string[] = []
    for (const rel of corpus) {
      const text = readFileSync(path.join(REPO, rel), 'utf8')
      for (const ctx of shellContexts(text)) {
        for (const hit of skillArgvHits(ctx)) hits.push(`${rel}: ${hit}`)
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
    const md = 'Run\n`bun`\n`skill://issue-triage/triage.ts init`\nnow.\n'
    const ctx = shellContexts(md)
    expect(ctx.some((c) => /bun.*skill:\/\//.test(c))).toBe(true)
    expect(ctx.some((c) => skillArgvHits(c).length > 0)).toBe(true)
  })

  it('X1 one-span: soft-wrapped bare form inside a single code span', () => {
    const md = 'Run `bun\n  skill://issue-triage/triage.ts init` now.\n'
    const ctx = shellContexts(md)
    expect(ctx.some((c) => /bun skill:\/\//.test(c))).toBe(true)
    expect(ctx.some((c) => skillArgvHits(c).length > 0)).toBe(true)
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
    const md = `
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
    const ctx = shellContexts(md)
    expect(ctx.length).toBeGreaterThanOrEqual(4)
    for (const c of ctx) expect(skillArgvHits(c).length).toBeGreaterThan(0)
  })

  it('scans indented code blocks', () => {
    const md = `
Here is an indented block:

    bun skill://issue-triage/triage.ts init

Done.
`
    const ctx = shellContexts(md)
    expect(ctx.some((c) => skillArgvHits(c).length > 0)).toBe(true)
  })

  it('skips known non-shell fences', () => {
    const md = '```ts\nconst x = "skill://issue-triage/triage.ts"\n```\n'
    expect(shellContexts(md)).toEqual([])
  })
})

describe('false positives stay clean', () => {
  it('citation span with no command word', () => {
    expect(skillArgvHits('skill://ci-watch/ci-watch.sh')).toEqual([])
    expect(
      shellContexts('See `skill://ci-watch/ci-watch.sh` for the path.').every((c) => skillArgvHits(c).length === 0),
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
    const md = 'Run `T=$(realpath skill://issue-triage/triage.ts) &&\n  bun "$T" init` now.\n'
    expect(shellContexts(md).every((c) => skillArgvHits(c).length === 0)).toBe(true)
  })
})
