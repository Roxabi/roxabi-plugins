/**
 * WS3 — the hygiene gate, executed.
 *
 * Exit codes are the contract: the frontmatter family defaults to `fail`
 * because it is machine-checkable, the bare-ref heuristic defaults to `warn`
 * because it is a style judgement. A gate that cannot turn red is theatre, so
 * every assertion here is on the process exit status, not on wording.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  it('refuses a frontmatter fence that is never closed', () => {
    // The terminator never fired, so the whole document was handed to the
    // field reader and `status`/`normative`/`date` were harvested out of body
    // prose. rc=0, "satisfies the frontmatter contract", while every YAML
    // reader — including this repo's own — sees no frontmatter at all.
    compliant('001-a.md', { axial: 'true' })
    writeFileSync(
      join(adrDir, '002-unclosed.md'),
      [
        '---',
        'title: "ADR-002: Unclosed"',
        'description: one line',
        '',
        '## Context',
        '',
        'The status of this work is accepted and it is normative for the date 2026-01-01.',
        '',
        'status: accepted',
        'normative: true',
        'date: 2026-01-01',
      ].join('\n'),
    )

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('opened and never closed')
  })

  it('rejects a `## status` body section whatever its case', () => {
    // The TypeScript reader strips `## status` as readily as `## Status`, so a
    // case-sensitive gate blessed a section the other half of the contract
    // deletes — two readers, two answers, which is the bug this contract exists
    // to kill.
    compliant('001-a.md', { axial: 'true' })
    adr(
      '002-b.md',
      { title: '"ADR-002: B"', status: 'accepted', normative: 'true', date: '2026-01-02' },
      '\n## status\n\nAccepted\n\n## Context\n\nx\n',
    )

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('status lives in frontmatter, once')
  })

  it('rejects a file that claims ADR shape but cannot be one', () => {
    // `12.md` was bound by this gate and invisible to `adr.ts`;
    // `2026-08-24-notes.md` was invisible here and set the next number to 2027.
    // Both are now the same finding: a name that is not an ADR name.
    compliant('001-a.md', { axial: 'true' })
    writeFileSync(join(adrDir, '12.md'), '---\ntitle: "ADR-012: No dash"\n---\n\n## Context\n\nx\n')
    writeFileSync(join(adrDir, '2026-08-24-notes.md'), '---\ntitle: notes\n---\n\n## Context\n\nx\n')

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('12.md: name does not parse as an ADR')
    expect(result.out).toContain('2026-08-24-notes.md: name does not parse as an ADR')
  })

  it('leaves files that make no ADR claim alone', () => {
    compliant('001-a.md', { axial: 'true' })
    writeFileSync(join(adrDir, 'README.md'), '# ADRs\n\nNot an ADR.\n')

    expect(run().code).toBe(0)
  })

  it('rejects one number claimed by two documents', () => {
    // The recursion fix stopped archiving from *freeing* a number. A number
    // handed out twice is the same corruption by another route, and nothing
    // looked for it.
    compliant('001-a.md', { axial: 'true' })
    compliant('0001-b.md')

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('is already claimed by another document')
  })
})

describe('exit contract', () => {
  // 0 or 1, always. The script ships by value into repos that cannot read it to
  // find out what a third code meant, and rc=2 / rc=141 both escaped before.

  it('reports an unreadable ADR as a violation and keeps scanning', () => {
    compliant('001-a.md', { axial: 'true' })
    adr('002-violates.md', { title: '"ADR-002: B"' })
    compliant('003-locked.md')
    chmodSync(join(adrDir, '003-locked.md'), 0o000)

    try {
      const result = run()
      expect(result.code).toBe(1)
      expect(result.out).toContain('003-locked.md: unreadable')
      // The abort used to take the scan with it: this finding never printed.
      expect(result.out).toContain('002-violates.md: missing `status`')
    } finally {
      chmodSync(join(adrDir, '003-locked.md'), 0o644)
    }
  })

  it('reports an unreadable subdirectory instead of exiting on an empty list', () => {
    compliant('001-a.md', { axial: 'true' })
    adr('002-violates.md', { title: '"ADR-002: B"' })
    mkdirSync(join(adrDir, 'archived'))
    chmodSync(join(adrDir, 'archived'), 0o000)

    try {
      const result = run()
      expect(result.code).toBe(1)
      expect(result.out).toContain('corpus scan incomplete')
      expect(result.out).toContain('002-violates.md: missing `status`')
    } finally {
      chmodSync(join(adrDir, 'archived'), 0o755)
    }
  })

  it('survives a pathological frontmatter block', () => {
    // A long block used to make `sed | head -1` take SIGPIPE, and `pipefail`
    // promoted 141 to the gate's verdict.
    compliant('001-a.md', { axial: 'true' })
    const padding = Array.from({ length: 40_000 }, () => 'status: accepted').join('\n')
    writeFileSync(
      join(adrDir, '002-huge.md'),
      `---\ntitle: "ADR-002: Huge"\nstatus: accepted\nnormative: true\ndate: 2026-01-02\n${padding}\n---\n\n## Context\n\nx\n`,
    )

    expect(run().code).toBe(0)
  })
})

describe('partial supersession', () => {
  it('accepts an in-force ADR that names what replaced a part of it', () => {
    compliant('001-a.md', { axial: 'true' })
    compliant('002-b.md', { superseded_in_part_by: '[ADR-001, #452]' })

    const result = run()
    expect(result.code).toBe(0)
    expect(result.out).toContain('satisfy the frontmatter contract')
  })

  it('rejects a partial qualifier on an ADR that is wholly replaced', () => {
    compliant('001-a.md', { axial: 'true' })
    adr('002-b.md', {
      title: '"ADR-002: B"',
      status: 'superseded',
      normative: 'false',
      date: '2026-01-02',
      superseded_by: 'ADR-001',
      superseded_in_part_by: '[ADR-001]',
    })

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('has no parts left in force')
  })

  it('rejects an entry that references nothing citable', () => {
    compliant('001-a.md', { axial: 'true' })
    compliant('002-b.md', { superseded_in_part_by: '[the refactor]' })

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('is not an `ADR-NNN` or `#NNN` reference')
  })

  it('rejects an ADR that names itself', () => {
    compliant('001-a.md', { axial: 'true' })
    compliant('002-b.md', { superseded_in_part_by: '[ADR-002]' })

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('names itself')
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

  it('counts an aliased declaration, so two of them still break the singleton', () => {
    // `axial: True` and `axial: yes` are `true` to any YAML parser. A check
    // that matched the literal reported *both* of these as "no axis declared"
    // and returned OK — while `adr.ts axial` returned `declared: false`, which
    // is the exact signal `/R-adr --axial` uses to write another one.
    compliant('001-a.md', { axial: 'True' })
    compliant('002-b.md', { axial: 'yes' })

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('axial singleton violated: 2')
  })

  it('rejects a boolean alias even when it is the only declaration', () => {
    compliant('001-a.md', { axial: 'True' })

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('is a YAML boolean alias')
    // Counted as a declaration, so the zero-axis branch must not also fire.
    expect(result.out).not.toContain('no axis of decomposition declared')
  })

  it('rejects a denial, because a non-axial ADR omits the key', () => {
    compliant('001-a.md', { axial: 'false' })

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('by omitting the key, not by denying it')
  })

  it('rejects a non-boolean axial value', () => {
    compliant('001-a.md', { axial: 'targets' })

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('is not a boolean')
  })

  it('rejects an aliased `normative`', () => {
    compliant('001-a.md', { axial: 'true' })
    adr('002-b.md', {
      title: '"ADR-002: B"',
      status: 'accepted',
      normative: 'True',
      date: '2026-01-02',
    })

    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain('is a YAML boolean alias')
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
