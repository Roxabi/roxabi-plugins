import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * External programs do not resolve `skill://`. A body may hand that URL only to
 * the builtins `realpath`, `read`, or `cat` — and only in a fail-closed shape
 * (`T=$(realpath …) && …` or `T=$(realpath …) || { …; exit 1; }`). The inline
 * `"$(realpath skill://…)"` argv form and the `;` form both fail open (#619).
 *
 * Corpus: every `.md` under plugins/.
 */

const REPO = path.resolve(import.meta.dirname, '../../../..')
const PLUGINS = path.join(REPO, 'plugins')

/**
 * #627 rewrites cleanup's bare bash skill:// sites. Until that PR lands on main,
 * allow-list only this file; remove the entry once merged.
 */
const ALLOWED = new Set(['plugins/omp-build/skills/cleanup/SKILL.md'])

const SHELLISH = /\b(?:bun|bash|node|sh|bunx|npx|realpath|read|cat)\b|\$\(/

/** `](skill://…)` markdown link targets are not shell argv. */
function inMarkdownLink(text: string, index: number): boolean {
  return text.slice(Math.max(0, index - 2), index) === ']('
}

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

/**
 * Shell contexts that may hand argv to an external program: fenced bash/sh/shell
 * (or unlabelled fences that look shellish), plus inline code spans that look
 * shellish. Prose skill citations (`skill://fix`) are not shell contexts.
 */
export function shellContexts(md: string): string[] {
  const out: string[] = []
  const fence = /```([^\n]*)\r?\n([\s\S]*?)```/g
  for (const m of md.matchAll(fence)) {
    const lang = m[1].trim().toLowerCase()
    const body = m[2]
    if (lang === 'bash' || lang === 'sh' || lang === 'shell' || (!lang && SHELLISH.test(body))) {
      if (body.includes('skill://')) out.push(joinContinuations(body))
    }
  }
  // Strip fences before scanning inline spans so ``` interiors are not re-read.
  const withoutFences = md.replace(/```[^\n]*\r?\n[\s\S]*?```/g, '')
  for (const m of withoutFences.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1]
    if (span.includes('skill://') && SHELLISH.test(span)) out.push(joinContinuations(span))
  }
  return out
}

/**
 * Failures: every `skill://` in a shell context that is not a fail-closed
 * builtin argument (or a quoted printf/echo message / markdown link).
 */
export function skillArgvHits(fragment: string): string[] {
  const hits: string[] = []
  const text = joinContinuations(fragment)

  // `T=$(realpath skill://…); bun "$T"` — realpath miss does not stop bun.
  if (/\$\(\s*realpath\s+skill:\/\/[^)]*\)\s*;/.test(text)) {
    hits.push('semicolon-form: T=$(realpath skill://…); …')
  }

  // `bun "$(realpath skill://…)"` — miss becomes bun "" and exits 0.
  if (/\b(?:bun|bash|node|sh|bunx|npx)\b[\s\S]{0,200}"\$\(\s*realpath\s+skill:\/\//.test(text)) {
    hits.push('inline-fail-open: <prog> "$(realpath skill://…)"')
  }

  let from = 0
  while (true) {
    const i = text.indexOf('skill://', from)
    if (i < 0) break
    from = i + 8

    if (inMarkdownLink(text, i)) continue

    // Local prefix: from the previous statement boundary to here.
    const boundary = Math.max(
      text.lastIndexOf('\n', i - 1),
      text.lastIndexOf(';', i - 1),
      text.lastIndexOf('&&', i - 1),
      text.lastIndexOf('||', i - 1),
      text.lastIndexOf('|', i - 1),
    )
    const local = text.slice(boundary + 1, i)

    // printf/echo messages may name the URL; they are not argv.
    if (/\b(?:printf|echo)\b\s+['"][^'"]*$/.test(local)) continue

    // Nested markdown/prose citation inside a larger shell string: `skill://…`
    // (the opening backtick sits immediately before the URL).
    if (/`$/.test(local)) continue

    // Allowed: realpath|read|cat immediately before the URL (optional quote).
    if (/(?:^|[\s`$()])(?:realpath|read|cat)\s+["']?$/.test(local)) continue

    // Quoted bare argv: bun 'skill://…' / bun "skill://…"
    if (/(?:^|[\s;|&])(?:bun|bash|node|sh|bunx|npx)\b[\s\S]*["']$/.test(local)) {
      hits.push(`quoted-argv: ${text.slice(Math.max(0, i - 24), i + 32).trim()}`)
      continue
    }

    hits.push(`bare-or-other: ${text.slice(Math.max(0, i - 24), i + 32).trim()}`)
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

  it('finds no unsafe skill:// in shell contexts outside the temporary allow-list', () => {
    const hits: string[] = []
    for (const rel of corpus) {
      if (ALLOWED.has(rel)) continue
      const text = readFileSync(path.join(REPO, rel), 'utf8')
      for (const ctx of shellContexts(text)) {
        for (const hit of skillArgvHits(ctx)) hits.push(`${rel}: ${hit}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('keep the allow-list honest: every entry still hits today', () => {
    for (const rel of ALLOWED) {
      const text = readFileSync(path.join(REPO, rel), 'utf8')
      const found = shellContexts(text).some((ctx) => skillArgvHits(ctx).length > 0)
      expect(found, rel).toBe(true)
    }
  })
})

describe('skillArgvHits shapes', () => {
  it('allows fail-closed T=$(realpath) && bun "$T"', () => {
    expect(skillArgvHits('T=$(realpath skill://issue-triage/triage.ts) && bun "$T" init')).toEqual([])
  })

  it('allows T=$(realpath) || { REFUSE; exit 1; }', () => {
    expect(
      skillArgvHits(`T=$(realpath skill://promote/lib/finalize.ts) || {
  printf 'REFUSE: cannot resolve skill://promote/lib/finalize.ts\\n'
  exit 1
}`),
    ).toEqual([])
  })

  it('allows read/cat builtins and markdown links', () => {
    expect(skillArgvHits('read skill://dev-review/root-causes.md')).toEqual([])
    expect(skillArgvHits('cat skill://ci-watch/ci-watch.sh')).toEqual([])
    expect(skillArgvHits('see [x](skill://promote/price.sh) for pricing')).toEqual([])
  })

  it("flags bun 'skill://'", () => {
    expect(skillArgvHits("bun 'skill://issue-triage/triage.ts' init")).not.toEqual([])
  })

  it('flags option + value forms', () => {
    expect(skillArgvHits('bash -o pipefail skill://cleanup/gather-state.sh')).not.toEqual([])
    expect(skillArgvHits('bun --cwd . skill://issue-triage/triage.ts init')).not.toEqual([])
  })

  it('joins continuations before scanning', () => {
    expect(
      skillArgvHits(`bash \\
  skill://cleanup/gather-state.sh`),
    ).not.toEqual([])
  })

  it('flags env-prefixed bare forms', () => {
    expect(skillArgvHits('GITHUB_REPO=acme/x bun skill://issue-triage/triage.ts init')).not.toEqual([])
  })

  it('flags the inline fail-open realpath-as-argv form', () => {
    expect(skillArgvHits('bun "$(realpath skill://issue-triage/triage.ts)" init')).not.toEqual([])
  })

  it('flags the semicolon fail-open form', () => {
    expect(skillArgvHits('T=$(realpath skill://issue-triage/triage.ts); bun "$T" init')).not.toEqual([])
  })
})
