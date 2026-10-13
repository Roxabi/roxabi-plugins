import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// Contracts that successive memory audits had to re-derive by hand (#316). Each is an
// inversion a well-meaning edit makes naturally, and each destroys or hides data:
//
//   1. "all tracked refs CLOSED → Delete". A closed issue makes an entry stale as a
//      *status tracker*; it does not make the entry worthless. The resolution must
//      demote it to a candidate and ask the Promote question first.
//   2. "delete, then sweep the dangling [[wikilinks]] afterwards". After the target
//      file is gone, a link broken by the purge is indistinguishable from a
//      deliberate forward-reference, so the sweep has to run before the removal.
//   3. The store path is derived from $PWD by a rule, not by an enumeration of the
//      separators one example happened to contain — and every caller derives it from
//      the same place. A `/`-only substitution resolves to a directory that exists
//      nowhere and reads as a healthy "no memory".
//   4. A check that could not run is not a check that passed. grep's exit 2 must
//      never take the same branch as its exit 1.
//
// The prose assertions below are ordering/structure checks, not keyword checks. The
// behavioural assertions run the cookbooks' own bash, including the production
// default path that no test used to exercise.

const SKILL_DIR = dirname(fileURLToPath(new URL('../SKILL.md', import.meta.url)))

const cookbook = (name: string): string => readFileSync(join(SKILL_DIR, 'cookbooks', `${name}.md`), 'utf-8')

const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8')

const DISCOVERY = cookbook('discovery')
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

const STORE = bashAfter(DISCOVERY, '### Project memory store')
const REF_STATE = bashAfter(ANALYSIS, '#### Ref-state sweep')
const BACKLINK = bashAfter(RESOLUTION, '### Backlink sweep')

const tmpRoots: string[] = []

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dev-core-cleanup-context-test-')))
  tmpRoots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpRoots) {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

function entry(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `---\nmetadata:\n  type: project\n---\n\n${body}\n`)
}

/**
 * The store-naming rule, written out independently of the shell that implements it:
 * every byte outside [A-Za-z0-9] becomes `-`. Deriving the expectation from the same
 * `tr` invocation under test would assert nothing.
 */
const slugOf = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')

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
function runRefState(
  memoryDir: string,
  states: Record<string, string> | 'unauthenticated' | 'absent',
  extraEnv: Record<string, string> = {},
): string {
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
      CLAUDE_SKILL_DIR: SKILL_DIR,
      memory_dir: memoryDir,
      ...extraEnv,
    },
  })
}

interface Run {
  stdout: string
  stderr: string
  status: number
}

/** Runs the backlink sweep, keeping stdout, stderr and the exit code apart. */
function runBacklink(opts: { stem: string; areas: string; cwd: string; home: string }): Run {
  const r = spawnSync('bash', ['-c', BACKLINK], {
    encoding: 'utf-8',
    cwd: opts.cwd,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: opts.home,
      CLAUDE_SKILL_DIR: SKILL_DIR,
      stem: opts.stem,
      areas: opts.areas,
    },
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 }
}

const notRoot = (process.getuid?.() ?? 0) !== 0

describe('project-memory store derivation', () => {
  it('lives in exactly one file, which both cookbooks cite instead of restating', () => {
    // The rule shipped broken because it existed twice and the copies drifted. The
    // guard is arity: one holder of the derivation, every other caller sourcing it.
    const holders = ['SKILL.md', 'memory-store.sh', 'cookbooks/discovery.md', 'cookbooks/analysis.md'].filter((f) =>
      /tr -c '?\[?a-zA-Z0-9/.test(readFileSync(join(SKILL_DIR, f), 'utf-8')),
    )
    expect(holders).toEqual(['memory-store.sh'])

    for (const doc of [DISCOVERY, ANALYSIS]) expect(doc).toMatch(/memory-store\.sh/)
  })

  it('resolves the production default for a path holding `_`, `.` and a leading `/`', () => {
    // Every other test injects $memory_dir through env, so the default derivation was
    // never executed — which is how a `/`-only substitution stayed green. This one
    // runs the cookbook with no override, from a cwd whose non-slash bytes matter.
    const home = scratch()
    const cwd = join(scratch(), 'my_project.v2', 'pkg')
    mkdirSync(cwd, { recursive: true })

    const store = join(home, '.claude', 'projects', slugOf(cwd), 'memory')
    mkdirSync(store, { recursive: true })
    entry(store, 'project_live_entry.md', 'Tracks #344.')

    const r = spawnSync('bash', ['-c', STORE], {
      encoding: 'utf-8',
      cwd,
      env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_SKILL_DIR: SKILL_DIR },
    })

    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/project_live_entry\.md/)
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/NO STORE/)
    // the `/`-only slug names a directory that exists nowhere
    expect(existsSync(join(home, '.claude', 'projects', cwd.replace(/\//g, '-')))).toBe(false)
  })

  it('says something different for an empty store and for a path that resolved to nothing', () => {
    const home = scratch()
    const cwd = join(scratch(), 'empty_case.v1')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(join(home, '.claude', 'projects', slugOf(cwd), 'memory'), { recursive: true })

    const run = (dir: string, h: string): Run => {
      const r = spawnSync('bash', ['-c', STORE], {
        encoding: 'utf-8',
        cwd: dir,
        env: { PATH: '/usr/bin:/bin', HOME: h, CLAUDE_SKILL_DIR: SKILL_DIR },
      })
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 }
    }

    const empty = run(cwd, home)
    const missing = run(scratch(), home)

    expect(empty.stdout).toMatch(/EMPTY/)
    expect(empty.stdout).not.toMatch(/NO STORE/)

    expect(missing.stderr).toMatch(/NO STORE/)
    expect(missing.stderr).toMatch(/resolved to nothing/)
    // "clean store" and "the derivation found nothing" must not read alike
    expect(`${missing.stdout}${missing.stderr}`).not.toMatch(/EMPTY/)
  })
})

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

  it('separates "gh did not answer" from "gh answered about something else"', () => {
    // `gh` does answer for a cross-repo ref or an ordinal like `#3`: it resolves the
    // number against *this* repo. The cause is not silence, and the failure is not
    // fail-safe — so it cannot share the row that says "reads as OPEN → keep".
    const silent = tableRow(ANALYSIS, /no answer/)
    expect(silent[2]).toMatch(/OPEN/)
    expect(silent[1]).not.toMatch(/another repo|ordinal/)

    const wrongThing = tableRow(ANALYSIS, /different thing/)
    expect(wrongThing[1]).toMatch(/another\*{0,2} repo/)
    expect(wrongThing[1]).toMatch(/ordinal/)
    expect(wrongThing[2]).toMatch(/DONE/)
    // the printed ref list is the operator's only check on this row
    expect(wrongThing[2]).toMatch(/ref list/)
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
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: process.env.HOME ?? '/tmp',
        CLAUDE_SKILL_DIR: SKILL_DIR,
        memory_dir: dir,
      },
    })

    const issued = readFileSync(calls, 'utf-8').trim().split('\n')
    expect(issued.sort()).toEqual(['344', '376'])
  })

  it('prices the sweep in unique refs before the first call', () => {
    const dir = scratch()
    entry(dir, 'a.md', 'Tracks #344 and #376.')
    entry(dir, 'b.md', 'Also #344.')

    const out = runRefState(dir, { 344: 'CLOSED', 376: 'MERGED' })
    const cost = out.indexOf('2 unique refs')

    expect(cost).toBeGreaterThan(-1)
    expect(cost).toBeLessThan(out.indexOf('344 DONE'))
  })

  it('CLEANUP_CONTEXT_SKIP_GH degrades to the absent-gh path without spending a call', () => {
    const dir = scratch()
    const calls = join(scratch(), 'calls')
    entry(dir, 'all-done.md', 'Tracks #344 and #376.')

    const bin = scratch()
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env bash\necho "$@" >> ${calls}\n[ "$1" = auth ] && exit 0\necho CLOSED\n`,
      {
        mode: 0o755,
      },
    )
    const out = execFileSync('bash', ['-c', REF_STATE], {
      encoding: 'utf-8',
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: process.env.HOME ?? '/tmp',
        CLAUDE_SKILL_DIR: SKILL_DIR,
        memory_dir: dir,
        CLEANUP_CONTEXT_SKIP_GH: '1',
      },
    })

    expect(existsSync(calls)).toBe(false)
    expect(out).toMatch(/WARN/)
    expect(out).not.toMatch(/CANDIDATE/)
    expect(out).toMatch(/KEEP\s+all-done\.md/)
  })

  it('keeps #0344 and #344 apart — refs are identifiers, not quantities', () => {
    const dir = scratch()
    entry(dir, 'zeros.md', 'Tracks #0344 and #344.')

    const out = runRefState(dir, { '0344': 'OPEN', 344: 'CLOSED' })

    expect(out).toMatch(/^0344 OPEN$/m)
    expect(out).toMatch(/^344 DONE$/m)
    // a numeric uniquifier folds the two together and judges the entry on a ref it
    // never cited; #0344 is still open, so the entry stays
    expect(out).toMatch(/KEEP\s+zeros\.md/)
    expect(out).toMatch(/refs .*0344/)
  })

  it('does not split an entry filename that contains whitespace', () => {
    const dir = scratch()
    entry(dir, 'my notes.md', 'Tracks #344.')

    const out = runRefState(dir, { 344: 'CLOSED' })

    expect(out).toMatch(/CANDIDATE my notes\.md/)
  })

  it('aborts instead of classifying an entry that is not inside the store', () => {
    const dir = scratch()
    entry(dir, 'a.md', 'Tracks #344.')

    // A grep that answers with a path outside the store — the shape a word-split
    // entry list produces. The classifier must refuse it, not basename it.
    const bin = scratch()
    for (const dep of ['bash', 'sed', 'mktemp', 'tr', 'sort', 'basename', 'tee', 'rm']) {
      symlinkSync(execFileSync('sh', ['-c', `command -v ${dep}`], { encoding: 'utf-8' }).trim(), join(bin, dep))
    }
    writeFileSync(
      join(bin, 'grep'),
      `#!/usr/bin/env bash\ncase " $* " in\n  *" -lZE "*) printf '/etc/passwd\\0'; exit 0 ;;\nesac\nexec /usr/bin/grep "$@"\n`,
      { mode: 0o755 },
    )

    const r = spawnSync('bash', ['-c', REF_STATE], {
      encoding: 'utf-8',
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: process.env.HOME ?? '/tmp',
        CLAUDE_SKILL_DIR: SKILL_DIR,
        memory_dir: dir,
      },
    })

    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/outside/)
    expect(r.stdout).not.toMatch(/passwd/)
  })
})

describe('Phase 4 backlink sweep', () => {
  it('is bound to the removal itself, so no resolution can slip past it', () => {
    const phase4 = RESOLUTION.slice(RESOLUTION.indexOf('## Phase 4'), RESOLUTION.indexOf('### Backlink sweep'))

    // blank-line-delimited paragraphs, each with its internal wrapping collapsed
    const epilogue = phase4
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .find((p) => /delete ε from source/i.test(p))
    if (!epilogue) throw new Error('no epilogue removing ε from source')

    // "sweep first, then remove" — the operands, in that order.
    expect(epilogue.search(/sweep/i)).toBeGreaterThan(-1)
    expect(epilogue.search(/sweep/i)).toBeLessThan(epilogue.search(/delete ε from source/i))
    // ...and it is the act that is guarded, not a list of labels
    expect(epilogue).toMatch(/after each/i)

    // Four resolutions, none carrying its own reminder: a per-label guard is what
    // left Fix — which removes the entry too — unguarded.
    const labels = phase4.split('\n').filter((l) => /^\d\. \*\*(Fix|Promote|Relocate|Delete)\*\*/.test(l))
    expect(labels).toHaveLength(4)
    for (const label of labels) expect(label).not.toMatch(/sweep/i)
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
    // every resolution, not three of the four
    expect(rule).toMatch(/any\*{0,2} resolution/i)
  })

  it('matches every citation form the wikilink grammar admits — and not a longer stem', () => {
    const dir = scratch()
    const cited = [
      'bare [[project_gh_actions_quota]]',
      'aliased [[project_gh_actions_quota|the quota note]]',
      'anchored [[project_gh_actions_quota#Billing API recipe]]',
      'suffixed [[project_gh_actions_quota.md]]',
      'suffixed aliased [[project_gh_actions_quota.md|the quota note]]',
      'suffixed anchored [[project_gh_actions_quota.md#Billing API recipe]]',
      'table-escaped [[project_gh_actions_quota\\|the quota note]]',
      'path-qualified [[memory/project_gh_actions_quota]]',
    ]
    writeFileSync(
      join(dir, 'citing.md'),
      [
        ...cited,
        'longer [[project_gh_actions_quota_v2]] is a different file',
        'longer suffixed [[project_gh_actions_quota_v2.md]] is too',
      ].join('\n'),
    )

    const r = runBacklink({ stem: 'project_gh_actions_quota', areas: dir, cwd: dir, home: scratch() })

    expect(r.status).toBe(0)
    const hits = r.stdout
      .split('\n')
      .filter((l) => /citing\.md:\d+:/.test(l))
      .map((l) => l.replace(/^.*?:\d+:/, ''))
    expect(hits).toEqual(cited)
  })

  it('reports no citations rather than failing silently', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'empty'), { recursive: true })

    const r = runBacklink({ stem: 'never-cited-anywhere', areas: join(dir, 'empty'), cwd: dir, home: scratch() })

    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/no citations/)
  })

  it.skipIf(!notRoot)('never calls the removal safe when the sweep could not run', () => {
    const dir = scratch()
    const blocked = join(dir, 'blocked')
    mkdirSync(blocked)
    writeFileSync(join(blocked, 'cites.md'), 'cites [[project_gh_actions_quota]]')
    chmodSync(blocked, 0o000)

    try {
      const r = runBacklink({ stem: 'project_gh_actions_quota', areas: dir, cwd: dir, home: scratch() })

      // grep exit ≥2 is "I could not look", not "nothing to find".
      expect(r.status).not.toBe(0)
      expect(r.stderr).toMatch(/SWEEP FAILED/)
      expect(r.stderr).toMatch(/UNKNOWN/)
      // the reason survives; the reassurance does not
      expect(r.stderr).toMatch(/Permission denied/)
      expect(`${r.stdout}${r.stderr}`).not.toMatch(/dangles nothing/)
    } finally {
      chmodSync(blocked, 0o755)
    }
  })

  it('repoints in-project citations but only reports out-of-project ones', () => {
    const home = scratch()
    const project = scratch()
    writeFileSync(join(project, 'notes.md'), 'local [[project_gh_actions_quota]]')

    const other = join(home, '.claude', 'projects', '-home-someone-else-repo', 'memory')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'topic.md'), 'remote [[project_gh_actions_quota]]')

    const r = runBacklink({
      stem: 'project_gh_actions_quota',
      areas: `${project}\n${other}`,
      cwd: project,
      home,
    })

    expect(r.stdout).toMatch(/IN-PROJECT/)
    expect(r.stdout).toMatch(/notes\.md:1:/)
    expect(r.stdout).toMatch(/OUT-OF-PROJECT/)
    expect(r.stdout).toMatch(/topic\.md:1:/)
    // Execute-all is consent for this project only — the other store is a separate,
    // separately-approved batch, so the pass stops rather than editing it.
    expect(r.stdout).toMatch(/STOP/)
    expect(r.status).toBe(3)
  })

  it('reports an α citation once when the search roots overlap', () => {
    const project = scratch()
    const agent = join(project, '.claude', 'agent-memory', 'be')
    mkdirSync(agent, { recursive: true })
    writeFileSync(join(agent, 'MEMORY.md'), 'cites [[project_gh_actions_quota]]')

    const r = runBacklink({
      stem: 'project_gh_actions_quota',
      areas: `${agent}\n${project}`,
      cwd: project,
      home: scratch(),
    })

    const hits = r.stdout.split('\n').filter((l) => /MEMORY\.md:\d+:/.test(l))
    expect(hits).toHaveLength(1)
  })
})
