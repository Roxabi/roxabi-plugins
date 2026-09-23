/**
 * `adr.ts axial`, executed.
 *
 * The exit code is what `/R-dev-init` Phase 3a and the axial interview branch
 * on, so it is the contract: two axial ADRs is the corpus contradiction and
 * exits 1; zero is a repo that has not run `/R-adr --axial` yet, which is a
 * state to report, not a failure to raise.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CLI = join(import.meta.dirname, '..', 'adr.ts')
const GATE = join(import.meta.dirname, '..', '..', '..', 'scripts', 'check-agents-adr-hygiene.sh')

let dir: string

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'adr-cli-')), 'adr')
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true })
})

function adr(nnn: string, extra = ''): void {
  writeFileSync(
    join(dir, `${nnn}-a.md`),
    `---\ntitle: "ADR-${nnn}: A"\nstatus: accepted\nnormative: true\ndate: 2026-01-01${extra}\n---\n\n## Context\n\nwhy.\n`,
  )
}

function cli(...argv: string[]): { code: number; json: Record<string, unknown>; out: string } {
  const result = spawnSync('bun', [CLI, ...argv, '--dir', dir], { encoding: 'utf-8' })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { code: result.status ?? -1, json: result.stdout ? JSON.parse(result.stdout) : {}, out }
}

function gate(): { code: number; out: string } {
  const clean: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(clean)) {
    if (k.startsWith('GIT_')) delete clean[k]
  }
  const result = spawnSync('bash', [GATE], {
    encoding: 'utf-8',
    env: { ...clean, AGENTS_ADR_ROOT: join(dir, '..'), AGENTS_ADR_DIR: dir, AGENTS_ADR_FILE: 'nope.md' },
  })
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function axialCli(): { code: number; json: Record<string, unknown> } {
  const { code, json } = cli('axial')
  return { code, json }
}

describe('adr.ts axial', () => {
  it('exits 0 and reports declared: false when no axis is declared', () => {
    adr('001')

    const { code, json } = axialCli()
    expect(code).toBe(0)
    expect(json).toMatchObject({ count: 0, declared: false, singleton: false, violated: false })
  })

  it('exits 0 when exactly one ADR is axial', () => {
    adr('001', '\naxial: true')

    const { code, json } = axialCli()
    expect(code).toBe(0)
    expect(json).toMatchObject({ count: 1, declared: true, singleton: true, violated: false })
  })

  it('exits 1 when two ADRs are axial', () => {
    adr('001', '\naxial: true')
    adr('002', '\naxial: true')

    const { code, json } = axialCli()
    expect(code).toBe(1)
    expect(json).toMatchObject({ count: 2, violated: true })
  })
  it('sees a declaration written in a YAML boolean alias', () => {
    // `declared: false` is what `/R-dev-init` Phase 3a branches on to launch
    // the interview that writes an axial ADR. On a repo whose axis is spelled
    // `axial: True` that branch wrote a second one.
    adr('001', '\naxial: True')

    const { code, json } = axialCli()
    expect(code).toBe(0)
    expect(json).toMatchObject({ count: 1, declared: true, singleton: true })
  })
})

describe('adr.ts next-nnn', () => {
  it('refuses to allocate off a corpus with a number-integrity fault', () => {
    adr('001')
    writeFileSync(join(dir, '0001-b.md'), '---\ntitle: t\nstatus: accepted\nnormative: true\ndate: 2026-01-01\n---\n')

    const { code, json } = cli('next-nnn')
    expect(code).toBe(1)
    expect(json.collisions).toHaveLength(1)
  })

  it('allocates normally on a clean corpus', () => {
    adr('001')
    adr('002')

    const { code, json } = cli('next-nnn')
    expect(code).toBe(0)
    expect(json).toMatchObject({ next: '003', collisions: [], misnamed: [] })
  })
})

describe('adr.ts supersede-in-part', () => {
  it('refuses a reference that cites nothing', () => {
    adr('001')

    const { code, out } = cli('supersede-in-part', '--nnn', '1', '--by', 'the refactor')
    expect(code).toBe(1)
    expect(out).toContain('names what replaced the part')
  })
})

/**
 * The two readers of this contract are a bash script and a TypeScript module.
 * Every defect this suite is priced against was the two disagreeing: on what an
 * ADR is, on whether `## status` counts, on whether `axial: True` is a
 * declaration, and — worst — on whether a file the gate calls dirty is one the
 * migrator will clean.
 */
describe('the gate and the library agree', () => {
  it('classifies the same files as ADRs', () => {
    adr('001')
    adr('0002')
    writeFileSync(join(dir, '12.md'), '---\ntitle: t\n---\n')
    writeFileSync(join(dir, '2026-08-24-notes.md'), '---\ntitle: t\n---\n')
    writeFileSync(join(dir, 'README.md'), '# ADRs\n')

    const seenByLibrary = (cli('list').json.active as { file: string }[]).map((r) => r.file).sort()
    expect(seenByLibrary).toEqual(['0002-a.md', '001-a.md'])

    // Everything the library declines and that still claims ADR shape is named
    // by the gate, so nothing falls between the two readers unremarked.
    const out = gate().out
    expect(out).toContain('12.md: name does not parse as an ADR')
    expect(out).toContain('2026-08-24-notes.md: name does not parse as an ADR')
    expect(out).not.toContain('README.md')
  })

  it('converges: a red gate, the remedy it prescribes, then a green gate', () => {
    // This is the loop that was closed. Before: gate rc=1, `/R-adr --migrate`
    // answered `changed: false, clean: true`, the file was untouched, and the
    // gate stayed rc=1 forever with no further move available.
    writeFileSync(
      join(dir, '001-a.md'),
      '---\ntitle: t\ndescription: d\nstatus: superseded\nnormative: true\ndate: 2026-01-01\nsuperseded_by: ADR-002\n---\n\n## Context\n\nx\n',
    )
    writeFileSync(
      join(dir, '002-b.mdx'),
      '---\ntitle: t\ndescription: d\n---\n\n## Status\n\nAccepted — 2026-03-15\n\n## Context\n\nx\n',
    )

    expect(gate().code).toBe(1)

    const { json } = cli('migrate')
    expect(json).toMatchObject({ clean: true })
    expect(json.migrated).toBe(2)

    expect(gate().code).toBe(0)
  })

  it('never calls a corpus clean while the gate calls it dirty', () => {
    // The invariant behind the convergence above: a violation the migrator
    // cannot derive a fix for must surface as a warning, so `clean: false` and
    // the gate's red name the same corpus.
    writeFileSync(
      join(dir, '001-a.mdx'),
      '---\ntitle: t\ndescription: d\n---\n\n## Status\n\nSuperseded — 2026-05-22 (script removed, nothing replaced it)\n\n## Context\n\nx\n',
    )

    const { json } = cli('migrate')
    expect(json.clean).toBe(false)
    expect(gate().code).toBe(1)
  })
})
