import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// Two contracts that three successive memory audits had to re-derive by hand (#316).
// Both are inversions a well-meaning edit makes naturally, and both destroy data:
//
//   1. "all tracked refs CLOSED → Delete". A closed issue makes an entry stale as a
//      *status tracker*; it does not make the entry worthless. The resolution must
//      demote it to a candidate and ask the Promote question first.
//   2. "delete, then sweep the dangling [[wikilinks]] afterwards". After the target
//      file is gone, a link broken by the purge is indistinguishable from a
//      deliberate forward-reference, so the sweep has to run before the removal.
//
// The prose assertions below are ordering checks, not keyword checks: rewriting the
// table cell to a bare `**Delete**`, or the step to "remove, then sweep", moves the
// operands and fails. The behavioural assertions run the cookbooks' own bash.

const cookbook = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../cookbooks/${name}.md`, import.meta.url)), 'utf-8')

const skill = readFileSync(fileURLToPath(new URL('../SKILL.md', import.meta.url)), 'utf-8')

const ANALYSIS = cookbook('analysis')
const RESOLUTION = cookbook('resolution')

/** Cells of the markdown table row whose first cell matches `signal`. */
function tableRow(doc: string, signal: RegExp): string[] {
  const row = doc
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .find((l) => signal.test(l.split('|')[1] ?? ''))
  if (!row) throw new Error(`no table row matching ${signal}`)
  return row.split('|').slice(1, -1)
}

/** The fenced bash block that follows `heading`. */
function bashAfter(doc: string, heading: string): string {
  const from = doc.indexOf(heading)
  if (from < 0) throw new Error(`heading not found: ${heading}`)
  const open = doc.indexOf('```bash', from)
  const close = doc.indexOf('```', open + 7)
  if (open < 0 || close < 0) throw new Error(`no bash block after ${heading}`)
  return doc.slice(open + 7, close)
}

const REF_STATE = bashAfter(ANALYSIS, '#### Ref-state sweep')
const BACKLINK = bashAfter(RESOLUTION, '### Backlink sweep')

const tmpRoots: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dev-core-cleanup-context-test-'))
  tmpRoots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

function entry(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `---\nmetadata:\n  type: project\n---\n\n${body}\n`)
}

/** External binaries the ref-state block invokes, `gh` aside. */
const REF_STATE_DEPS = ['bash', 'grep', 'sed', 'mktemp', 'tr', 'sort', 'basename', 'tee', 'rm']

/**
 * A PATH holding only `REF_STATE_DEPS`, so `command -v gh` genuinely fails. Stripping
 * entries off the real PATH does not work here: `gh` is installed in the same
 * directory as coreutils.
 */
function binWithoutGh(): string {
  const bin = scratch()
  for (const dep of REF_STATE_DEPS) {
    const real = execFileSync('sh', ['-c', `command -v ${dep}`], { encoding: 'utf-8' }).trim()
    symlinkSync(real, join(bin, dep))
  }
  return bin
}

/**
 * Runs the ref-state block against a `gh` whose answers are known, so classification
 * is exercised without reaching the network.
 *
 * `states`: ref number → what the stub prints. A ref absent from the map makes the
 * stub exit 1 — how a real `gh` reports a ref it cannot resolve.
 * `'unauthenticated'`: `gh` exists but every call fails, incl. `gh auth status`.
 * `'absent'`: `gh` is not on PATH at all.
 */
function runRefState(memoryDir: string, states: Record<string, string> | 'unauthenticated' | 'absent'): string {
  let bin: string
  if (states === 'absent') {
    bin = binWithoutGh()
  } else {
    bin = scratch()
    const body =
      states === 'unauthenticated'
        ? 'exit 1\n'
        : `[ "$1" = auth ] && exit 0\ncase "$3" in\n${Object.entries(states)
            .map(([n, s]) => `  ${n}) echo ${s} ;;`)
            .join('\n')}\n  *) exit 1 ;;\nesac\n`
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\n${body}`, { mode: 0o755 })
  }
  return execFileSync('bash', ['-c', REF_STATE], {
    encoding: 'utf-8',
    env: {
      PATH: states === 'absent' ? bin : `${bin}:/usr/bin:/bin`,
      HOME: process.env.HOME ?? '/tmp',
      memory_dir: memoryDir,
    },
  })
}

describe('§2f ref-state sweep', () => {
  it('classifies an all-closed entry as a candidate that must be offered to Promote first', () => {
    const [signal, resolution] = tableRow(ANALYSIS, /All tracked refs CLOSED/)

    expect(signal).toContain('CLOSED')
    // The contract is the ordering. A cell that reaches Delete without naming
    // Promote, or names Delete before Promote, is the inverted rule.
    expect(resolution).toMatch(/Promote/)
    const promote = resolution.indexOf('Promote')
    const del = resolution.indexOf('Delete')
    expect(del === -1 || promote < del).toBe(true)
  })

  it('states the Promote question as step 1 and Delete as reachable only on "no"', () => {
    const from = ANALYSIS.indexOf('#### Ref-state sweep')
    const section = ANALYSIS.slice(from, ANALYSIS.indexOf('```bash', from))
    const promote = section.indexOf('Promote')
    const del = section.indexOf('Delete')
    expect(promote).toBeGreaterThan(-1)
    expect(del).toBeGreaterThan(promote)
  })

  it('keeps an entry whose refs are unresolvable — never treats unknown as closed', () => {
    const [signal, resolution] = tableRow(ANALYSIS, /unresolvable/)

    expect(signal).toMatch(/OPEN/)
    expect(resolution).toMatch(/Keep/)
    expect(resolution).not.toMatch(/Delete/)
  })

  it('CANDIDATE when every ref is CLOSED/MERGED, KEEP when one is still OPEN', () => {
    const dir = scratch()
    entry(dir, 'all-done.md', 'Tracks #344 and #376.')
    entry(dir, 'one-live.md', 'Tracks #344 and #999.')
    entry(dir, 'no-refs.md', 'A durable invariant with no tracker.')

    const out = runRefState(dir, { 344: 'CLOSED', 376: 'MERGED', 999: 'OPEN' })

    expect(out).toMatch(/CANDIDATE all-done\.md/)
    expect(out).toMatch(/KEEP\s+one-live\.md/)
    expect(out).toMatch(/KEEP\s+no-refs\.md/)
  })

  it('fails toward keeping: an unresolvable ref does not make an entry a candidate', () => {
    const dir = scratch()
    // #344 is finished, #12345 answers nothing — wrong repo, a heading anchor, an
    // ordinal, a rate limit. Reading that silence as "closed" purges the entry.
    entry(dir, 'one-unknown.md', 'Tracks #344 and #12345.')

    const out = runRefState(dir, { 344: 'CLOSED' })

    expect(out).toMatch(/UNRESOLVED/)
    expect(out).toMatch(/KEEP\s+one-unknown\.md/)
    expect(out).not.toMatch(/CANDIDATE/)
  })

  it.each(['absent', 'unauthenticated'] as const)('degrades visibly and keeps everything when gh is %s', (mode) => {
    const dir = scratch()
    entry(dir, 'all-done.md', 'Tracks #344 and #376.')

    const out = runRefState(dir, mode)

    expect(out).toMatch(/WARN/)
    expect(out).not.toMatch(/CANDIDATE/)
    expect(out).toMatch(/KEEP\s+all-done\.md/)
  })

  it('issues exactly one gh call per unique ref, not one per entry', () => {
    const dir = scratch()
    const calls = join(scratch(), 'calls')
    entry(dir, 'a.md', 'Tracks #344 and #376.')
    entry(dir, 'b.md', 'Also tracks #344 and #376.')
    entry(dir, 'c.md', 'And #344 again.')

    const bin = scratch()
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env bash\n[ "$1" = auth ] && exit 0\necho "$3" >> ${calls}\necho CLOSED\n`,
      { mode: 0o755 },
    )
    execFileSync('bash', ['-c', REF_STATE], {
      encoding: 'utf-8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME ?? '/tmp', memory_dir: dir },
    })

    const issued = readFileSync(calls, 'utf-8').trim().split('\n')
    expect(issued.sort()).toEqual(['344', '376'])
  })
})

describe('Phase 4 backlink sweep', () => {
  it('is a sub-step of Delete that runs before the removal', () => {
    const step = RESOLUTION.split('\n').find((l) => /^4\. \*\*Delete\*\*/.test(l))
    if (!step) throw new Error('Phase 4 Delete step not found')

    // "sweep first, then remove from source" — the operands, in that order. The
    // afterward-variant ("remove from source, then sweep") inverts them.
    const sweep = step.search(/sweep/i)
    const remove = step.search(/remove from source/i)
    expect(sweep).toBeGreaterThan(-1)
    expect(remove).toBeGreaterThan(-1)
    expect(sweep).toBeLessThan(remove)
  })

  it('binds the sweep to Promote and Relocate too — both move content', () => {
    const steps = RESOLUTION.split('\n').filter((l) => /^[23]\. \*\*(Promote|Relocate)\*\*/.test(l))
    expect(steps).toHaveLength(2)
    for (const step of steps) expect(step).toMatch(/sweep/i)
  })

  it('names the anchored-citation case Promote/Relocate creates', () => {
    const section = RESOLUTION.slice(RESOLUTION.indexOf('### Backlink sweep'))
    expect(section).toMatch(/\[\[stem#heading\]\]/)
  })

  it('carries it into SKILL.md safety rules', () => {
    const safety = skill.slice(skill.indexOf('## Safety'), skill.indexOf('## Edge Cases'))
    const rule = safety.split('\n').find((l) => /wikilink/i.test(l))
    if (!rule) throw new Error('no wikilink safety rule')
    expect(rule.search(/sweep/i)).toBeLessThan(rule.search(/removal|remove/i))
  })

  it('matches bare, aliased and anchored citations — and not a longer stem', () => {
    const dir = scratch()
    writeFileSync(
      join(dir, 'citing.md'),
      [
        'bare [[project_gh_actions_quota]]',
        'aliased [[project_gh_actions_quota|the quota note]]',
        'anchored [[project_gh_actions_quota#Billing API recipe]]',
        'longer [[project_gh_actions_quota_v2]] is a different file',
      ].join('\n'),
    )

    const out = execFileSync('bash', ['-c', BACKLINK], {
      encoding: 'utf-8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        stem: 'project_gh_actions_quota',
        areas: dir,
      },
    })

    const hits = out.trim().split('\n')
    expect(hits).toHaveLength(3)
    expect(hits.map((h) => h.replace(/^.*?:\d+:/, ''))).toEqual([
      'bare [[project_gh_actions_quota]]',
      'aliased [[project_gh_actions_quota|the quota note]]',
      'anchored [[project_gh_actions_quota#Billing API recipe]]',
    ])
  })

  it('reports no citations rather than failing silently', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'empty'), { recursive: true })

    const out = execFileSync('bash', ['-c', BACKLINK], {
      encoding: 'utf-8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        stem: 'never-cited-anywhere',
        areas: join(dir, 'empty'),
      },
    })

    expect(out).toMatch(/no citations/)
  })
})
