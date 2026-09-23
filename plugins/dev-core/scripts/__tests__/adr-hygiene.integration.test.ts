/**
 * WS3 — the hygiene gate, executed.
 *
 * Exit codes are the contract: the frontmatter family defaults to `fail`
 * because it is machine-checkable, the bare-ref heuristic defaults to `warn`
 * because it is a style judgement. A gate that cannot turn red is theatre, so
 * every assertion here is on the process exit status, not on wording.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = join(import.meta.dirname, '..', 'check-agents-adr-hygiene.sh')

let root: string
let adrDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adr-hygiene-'))
  adrDir = join(root, 'docs', 'architecture', 'adr')
  mkdirSync(adrDir, { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), '# Agents\n\nSee [ADR-001](docs/architecture/adr/001-a.md).\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

interface Run {
  code: number
  out: string
}

function run(env: NodeJS.ProcessEnv = {}): Run {
  const clean: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(clean)) {
    if (k.startsWith('GIT_')) delete clean[k]
  }
  const result = spawnSync('bash', [script], {
    encoding: 'utf-8',
    env: { ...clean, AGENTS_ADR_ROOT: root, AGENTS_ADR_DIR: adrDir, ...env },
  })
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function adr(name: string, fields: Record<string, string>, body = '\n## Context\n\nwhy.\n'): void {
  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  writeFileSync(join(adrDir, name), `---\n${fm}\n---\n${body}`)
}

function compliant(name: string, extra: Record<string, string> = {}): void {
  adr(name, {
    title: `"ADR-001: ${name}"`,
    description: 'one line',
    status: 'accepted',
    normative: 'true',
    date: '2026-01-01',
    ...extra,
  })
}

describe('frontmatter contract family', () => {
  it('passes a compliant corpus', () => {
    compliant('001-a.md', { axial: 'true' })

    const result = run()
    expect(result.code).toBe(0)
    expect(result.out).toContain('satisfy the frontmatter contract')
  })

  it('fails by default on a missing status', () => {
    compliant('001-a.md', { axial: 'true' })
    adr('002-b.md', { title: '"ADR-002: B"', normative: 'true', date: '2026-01-02' })

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('missing `status`')
  })

  it('reports the same finding without failing when asked to warn', () => {
    compliant('001-a.md', { axial: 'true' })
    adr('002-b.md', { title: '"ADR-002: B"', normative: 'true', date: '2026-01-02' })

    const result = run({ AGENTS_ADR_CONTRACT_MODE: 'warn' })
    expect(result.code).toBe(0)
    expect(result.out).toContain('missing `status`')
  })

  it('rejects a status outside the lowercase vocabulary', () => {
    compliant('001-a.md', { axial: 'true' })
    adr('002-b.md', {
      title: '"ADR-002: B"',
      status: 'Accepted',
      normative: 'true',
      date: '2026-01-02',
    })

    expect(run().code).toBe(1)
  })

  it('rejects a superseded ADR that still claims binding authority', () => {
    compliant('001-a.md', { axial: 'true' })
    adr('002-b.md', {
      title: '"ADR-002: B"',
      status: 'superseded',
      normative: 'true',
      date: '2026-01-02',
      superseded_by: 'ADR-001',
    })

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('requires normative: false')
  })

  it('rejects a superseded ADR that names no replacement', () => {
    compliant('001-a.md', { axial: 'true' })
    adr('002-b.md', {
      title: '"ADR-002: B"',
      status: 'superseded',
      normative: 'false',
      date: '2026-01-02',
    })

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('names its replacement')
  })

  it('rejects a surviving `## Status` body section', () => {
    compliant('001-a.md', { axial: 'true' })
    adr(
      '002-b.md',
      { title: '"ADR-002: B"', status: 'accepted', normative: 'true', date: '2026-01-02' },
      '\n## Status\n\nAccepted\n\n## Context\n\nx\n',
    )

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('status lives in frontmatter, once')
  })

  it('checks archived ADRs too', () => {
    compliant('001-a.md', { axial: 'true' })
    mkdirSync(join(adrDir, 'archived'))
    writeFileSync(
      join(adrDir, 'archived', '002-old.md'),
      '---\ntitle: "ADR-002: Old"\nstatus: superseded\nnormative: true\ndate: 2026-01-02\nsuperseded_by: ADR-001\n---\n\n## Context\n\nx\n',
    )

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('archived/002-old.md')
  })
})

describe('axial', () => {
  it('passes a corpus that has not declared an axis yet', () => {
    // Zero axial ADRs is every repo that adopted the gate before running
    // `/R-adr --axial`. Failing that is being red on arrival.
    compliant('001-a.md')

    const result = run()
    expect(result.code).toBe(0)
    expect(result.out).toContain('no axis of decomposition declared')
  })

  it('fails on a missing axis only when the repo asked for that assertion', () => {
    compliant('001-a.md')

    const result = run({ AGENTS_ADR_AXIAL_MODE: 'fail' })
    expect(result.code).toBe(1)
    expect(result.out).toContain('no axis of decomposition declared')
  })

  it('reports a missing axis without failing in warn mode', () => {
    compliant('001-a.md')

    const result = run({ AGENTS_ADR_AXIAL_MODE: 'warn' })
    expect(result.code).toBe(0)
    expect(result.out).toContain('WARN: no ADR carries `axial: true`')
  })

  it('fails when two ADRs are axial, whatever the axial mode', () => {
    // Two axes of decomposition is a contradiction, not a maturity level:
    // this one is the invariant, so opting out of the assertion cannot mute it.
    compliant('001-a.md', { axial: 'true' })
    compliant('002-b.md', { axial: 'true' })

    for (const env of [{}, { AGENTS_ADR_AXIAL_MODE: 'off' }]) {
      const result = run(env)
      expect(result.code).toBe(1)
      expect(result.out).toContain('axial singleton violated: 2')
      expect(result.out).toContain('001-a.md')
      expect(result.out).toContain('002-b.md')
    }
  })

  it('still resolves exactly one after the previous axial ADR is archived', () => {
    compliant('002-new.md', { axial: 'true' })
    mkdirSync(join(adrDir, 'archived'))
    writeFileSync(
      join(adrDir, 'archived', '001-old.md'),
      '---\ntitle: "ADR-001: Old"\nstatus: superseded\nnormative: false\ndate: 2026-01-01\nsuperseded_by: ADR-002\n---\n\n## Context\n\nx\n',
    )

    expect(run().code).toBe(0)
  })
})

describe('bare-ref family', () => {
  it('warns without failing by default', () => {
    compliant('001-a.md', { axial: 'true' })
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\n\nObey ADR-0002 at all times.\n')

    const result = run()
    expect(result.code).toBe(0)
    expect(result.out).toContain('WARN:')
    expect(result.out).toContain('bare ADR-NNN')
  })

  it('fails when the caller asks it to', () => {
    compliant('001-a.md', { axial: 'true' })
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\n\nObey ADR-0002 at all times.\n')

    const result = run({ AGENTS_ADR_MODE: 'fail' })
    expect(result.code).toBe(1)
    expect(result.out).toContain('FAIL:')
  })

  it('accepts a linked reference', () => {
    compliant('001-a.md', { axial: 'true' })

    const result = run()
    expect(result.code).toBe(0)
    expect(result.out).toContain('no bare ADR-NNN')
  })

  it('quotes a pointer doc only when one is configured', () => {
    compliant('001-a.md', { axial: 'true' })
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\n\nObey ADR-0002 at all times.\n')

    expect(run().out).not.toContain('§ AGENTS.md ADR hygiene')
    expect(run({ AGENTS_ADR_DOC: 'docs/debt.md' }).out).toContain('docs/debt.md § AGENTS.md ADR hygiene')
  })
})
