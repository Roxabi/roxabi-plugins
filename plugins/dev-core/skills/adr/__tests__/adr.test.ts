import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ADR_STATUSES,
  type AdrFile,
  adrCollisions,
  axialAdrs,
  deprecateAdr,
  interpretStatusLine,
  listAdrs,
  migrateAdrFile,
  misnamedAdrs,
  nextNnn,
  normativeFor,
  parseFrontmatter,
  parseRefList,
  scanAdrs,
  setFrontmatter,
  supersedeAdr,
  supersedeAdrInPart,
} from '../lib/adr'

let dir: string

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'adr-test-')), 'adr')
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeAdr(name: string, frontmatter: string, body = '\n## Context\n\nwhy.\n'): string {
  const path = join(dir, name)
  mkdirSync(join(dir, '..'), { recursive: true })
  writeFileSync(path, `---\n${frontmatter}\n---\n${body}`)
  return path
}

function accepted(nnn: string, title: string): string {
  return writeAdr(
    `${nnn}-${title}.md`,
    [
      `title: "ADR-${nnn}: ${title}"`,
      'description: one line',
      'status: accepted',
      'normative: true',
      'date: 2026-01-01',
    ].join('\n'),
  )
}

function find(nnn: number): AdrFile {
  const adr = scanAdrs(dir).find((a) => a.nnn === nnn)
  if (!adr) throw new Error(`ADR ${nnn} not found`)
  return adr
}

describe('number allocation', () => {
  it('hands a new ADR a number past every archived one', () => {
    for (const n of ['0001', '0002', '0003', '0004', '0005']) accepted(n, `decision-${n}`)

    supersedeAdr(find(3), 'ADR-0006', dir)
    expect(existsSync(join(dir, 'archived', '0003-decision-0003.md'))).toBe(true)
    expect(existsSync(join(dir, '0003-decision-0003.md'))).toBe(false)
    expect(nextNnn(dir)).toBe('0006')

    // Archiving the *highest* ADR is what makes the recursion observable: with a
    // flat scan the directory's visible maximum drops back to 0005 and 0006 is
    // handed out a second time, so ADR-0006 would name two unrelated decisions.
    accepted('0006', 'decision-0006')
    supersedeAdr(find(6), 'ADR-0007', dir)
    expect(nextNnn(dir)).toBe('0007')
  })

  it('never reissues a number after the highest ADR itself is archived', () => {
    for (const n of ['0001', '0002', '0003', '0004', '0005']) accepted(n, `decision-${n}`)
    supersedeAdr(find(5), 'ADR-0006', dir)

    expect(nextNnn(dir)).toBe('0006')
  })

  it('keeps the padding width the corpus already uses', () => {
    accepted('001', 'first')
    expect(nextNnn(dir)).toBe('002')
  })

  it('starts at 001 in an empty directory', () => {
    expect(nextNnn(dir)).toBe('001')
    expect(nextNnn(join(dir, 'nope'))).toBe('001')
  })

  it('counts legacy .mdx ADRs', () => {
    writeAdr('007-legacy.mdx', 'title: "ADR-007: Legacy"')
    expect(nextNnn(dir)).toBe('008')
  })
})

describe('supersede', () => {
  it('drops binding authority, names the replacement, and archives the file', () => {
    accepted('001', 'old')
    const result = supersedeAdr(find(1), 'ADR-002', dir)

    expect(result.to).toBe(join(dir, 'archived', '001-old.md'))
    const fields = parseFrontmatter(readFileSync(result.to, 'utf-8'))
    expect(fields.status).toBe('superseded')
    expect(fields.normative).toBe('false')
    expect(fields.superseded_by).toBe('ADR-002')
  })

  it('strips the axial marker so the singleton survives archiving', () => {
    writeAdr(
      '001-axis.md',
      'title: "ADR-001: Axis of Decomposition"\nstatus: accepted\nnormative: true\ndate: 2026-01-01\naxial: true',
    )
    expect(axialAdrs(dir)).toHaveLength(1)

    const result = supersedeAdr(find(1), 'ADR-002', dir)
    expect(result.axialStripped).toBe(true)

    writeAdr(
      '002-axis.md',
      'title: "ADR-002: Axis of Decomposition"\nstatus: accepted\nnormative: true\ndate: 2026-02-01\naxial: true',
    )

    // Recursive search — an archived ADR that kept `axial: true` would break the
    // singleton the review path greps for.
    const axial = axialAdrs(dir)
    expect(axial).toHaveLength(1)
    expect(axial[0].name).toBe('002-axis.md')
  })
})

describe('deprecate', () => {
  it('drops binding authority but leaves the file in place', () => {
    accepted('001', 'old')
    const result = deprecateAdr(find(1))

    expect(result.to).toBe(join(dir, '001-old.md'))
    expect(existsSync(join(dir, 'archived', '001-old.md'))).toBe(false)

    const fields = parseFrontmatter(readFileSync(result.to, 'utf-8'))
    expect(fields.status).toBe('deprecated')
    expect(fields.normative).toBe('false')
    expect(fields.superseded_by).toBeUndefined()
  })
})

describe('normative', () => {
  it('is false exactly for the statuses that stopped being law', () => {
    const byStatus = Object.fromEntries(ADR_STATUSES.map((s) => [s, normativeFor(s)]))
    expect(byStatus).toEqual({
      proposed: true,
      accepted: true,
      deprecated: false,
      superseded: false,
    })
  })
})

describe('list', () => {
  it('presents archived ADRs apart from active ones', () => {
    accepted('001', 'one')
    accepted('002', 'two')
    supersedeAdr(find(1), 'ADR-002', dir)

    const { active, archived } = listAdrs(dir)
    expect(active.map((a) => a.nnn)).toEqual([2])
    expect(archived.map((a) => a.nnn)).toEqual([1])
  })

  it('reads status and date from frontmatter — the fields create mode writes', () => {
    accepted('001', 'one')
    const [adr] = listAdrs(dir).active
    expect(adr.fields.status).toBe('accepted')
    expect(adr.fields.date).toBe('2026-01-01')
    expect(adr.fields.title).toBe('ADR-001: one')
  })
})

describe('frontmatter editing', () => {
  it('preserves a folded block scalar it does not touch', () => {
    const text = '---\ntitle: "ADR-001: X"\ndescription: >\n  line one\n  line two\n---\n\n## Context\n'
    const out = setFrontmatter(text, { status: 'accepted' })

    expect(out).toContain('description: >\n  line one\n  line two')
    expect(parseFrontmatter(out).description).toBe('line one line two')
    expect(parseFrontmatter(out).status).toBe('accepted')
  })

  it('inserts new keys in canonical order', () => {
    const text = '---\ntitle: "ADR-001: X"\ndescription: d\n---\n\n## Context\n'
    const out = setFrontmatter(text, { date: '2026-01-01', status: 'accepted', normative: 'true' })
    const keys = out
      .split('\n')
      .slice(1, 6)
      .map((l) => l.split(':')[0])

    expect(keys).toEqual(['title', 'description', 'status', 'normative', 'date'])
  })

  it('removes a key and its folded continuation lines', () => {
    const text = '---\ntitle: t\ndescription: >\n  a\n  b\naxial: true\n---\n\nbody\n'
    const out = setFrontmatter(text, { description: null })

    expect(out).not.toContain('  a')
    expect(parseFrontmatter(out)).toEqual({ title: 't', axial: 'true' })
  })
})

describe('migrate', () => {
  it('backfills status, normative and date from the body section, then drops it', () => {
    const path = writeAdr(
      '001-old.mdx',
      'title: "ADR-001: Old"\ndescription: d',
      '\n## Status\n\nAccepted — 2026-03-15\n\n## Context\n\nwhy.\n',
    )
    const report = migrateAdrFile(path)

    expect(report).toMatchObject({ changed: true, status: 'accepted', normative: true, date: '2026-03-15' })
    const text = readFileSync(path, 'utf-8')
    expect(parseFrontmatter(text)).toMatchObject({ status: 'accepted', normative: 'true', date: '2026-03-15' })
    expect(text).not.toContain('## Status')
    expect(text).toContain('## Context')
  })

  it('reads the replacement out of "Superseded by ADR-016"', () => {
    const path = writeAdr(
      '007-doc.mdx',
      'title: t\ndescription: d',
      '\n## Status\n\nSuperseded by ADR-016\n\n## Context\n\nx\n',
    )
    const report = migrateAdrFile(path, { dates: {} })

    expect(report.status).toBe('superseded')
    expect(report.supersededBy).toBe('ADR-016')
    expect(report.normative).toBe(false)
    expect(parseFrontmatter(readFileSync(path, 'utf-8')).superseded_by).toBe('ADR-016')
  })

  it('does not mark an in-force ADR as replaced because its body mentions a partial supersede', () => {
    const path = writeAdr(
      '005-hex.mdx',
      'title: t\ndescription: d',
      '\n## Status\n\nAccepted. **Partially superseded by [ADR-015](015-x.mdx) for the TypeScript layer**.\n\n## Context\n\nx\n',
    )
    const report = migrateAdrFile(path, { dates: { [path]: '2026-06-12' } })

    expect(report.status).toBe('accepted')
    expect(report.supersededBy).toBeNull()
    expect(parseFrontmatter(readFileSync(path, 'utf-8')).superseded_by).toBeUndefined()
  })

  it('falls back to the supplied date when the body carries none', () => {
    const path = writeAdr('001-old.mdx', 'title: t\ndescription: d', '\n## Status\n\nAccepted\n\n## Context\n\nx\n')
    const report = migrateAdrFile(path, { dates: { [path]: '2026-04-22' } })

    expect(report.date).toBe('2026-04-22')
    expect(report.warnings).toEqual([])
  })

  it('refuses to invent a replacement and says so', () => {
    const path = writeAdr(
      '010-chain.mdx',
      'title: t\ndescription: d',
      '\n## Status\n\nSuperseded — 2026-05-22 (script removed, nothing replaced it)\n\n## Context\n\nx\n',
    )
    const report = migrateAdrFile(path)

    expect(report.supersededBy).toBeNull()
    expect(report.warnings).toContainEqual(expect.stringContaining('needs a human'))
    expect(parseFrontmatter(readFileSync(path, 'utf-8')).superseded_by).toBeUndefined()
  })

  it('leaves a contract-clean ADR alone', () => {
    const path = accepted('001', 'clean')
    const before = readFileSync(path, 'utf-8')
    const report = migrateAdrFile(path)

    expect(report.changed).toBe(false)
    expect(readFileSync(path, 'utf-8')).toBe(before)
  })

  it('writes nothing in dry-run mode', () => {
    const path = writeAdr('001-old.mdx', 'title: t\ndescription: d', '\n## Status\n\nAccepted\n\n## Context\n\nx\n')
    const before = readFileSync(path, 'utf-8')
    const report = migrateAdrFile(path, { dryRun: true, dates: { [path]: '2026-01-01' } })

    expect(report.status).toBe('accepted')
    expect(readFileSync(path, 'utf-8')).toBe(before)
  })
  it('repairs a `normative` that contradicts the authored status', () => {
    // The closed loop this kills: the gate reports "status 'superseded'
    // requires normative: false, found true", its prescribed remedy
    // (`/R-adr --migrate`) answers `changed: false, clean: true` while its own
    // report field says `normative: false`, the file is never touched, and the
    // gate is still red. `alreadyClean` asked whether `normative` was
    // *present*, never whether it agreed with the status.
    const path = writeAdr(
      '002-b.md',
      'title: t\ndescription: d\nstatus: superseded\nnormative: true\ndate: 2026-01-02\nsuperseded_by: ADR-001',
    )
    const report = migrateAdrFile(path)

    expect(report.changed).toBe(true)
    expect(report.normative).toBe(false)
    expect(parseFrontmatter(readFileSync(path, 'utf-8')).normative).toBe('false')
  })

  it('reports what it writes — the file and the report never disagree', () => {
    const path = writeAdr(
      '002-b.md',
      'title: t\ndescription: d\nstatus: superseded\nnormative: true\ndate: 2026-01-02\nsuperseded_by: ADR-001',
    )
    const report = migrateAdrFile(path)
    const fields = parseFrontmatter(readFileSync(path, 'utf-8'))

    expect(fields.status).toBe(report.status)
    expect(fields.normative).toBe(String(report.normative))
    expect(fields.date).toBe(report.date)
    expect(fields.superseded_by).toBe(report.supersededBy)
  })

  it('normalises a status whose only fault is case', () => {
    const path = writeAdr('001-a.md', 'title: t\ndescription: d\nstatus: Accepted\nnormative: true\ndate: 2026-01-01')
    const report = migrateAdrFile(path)

    expect(report.status).toBe('accepted')
    expect(parseFrontmatter(readFileSync(path, 'utf-8')).status).toBe('accepted')
  })

  it('refuses to guess a status outside the vocabulary', () => {
    const path = writeAdr('001-a.md', 'title: t\ndescription: d\nstatus: retired\nnormative: true\ndate: 2026-01-01')
    const report = migrateAdrFile(path)

    expect(report.warnings).toContainEqual(expect.stringContaining('not in the vocabulary'))
  })

  it('flags a `superseded_by` that its own status contradicts', () => {
    const path = writeAdr(
      '001-a.md',
      'title: t\ndescription: d\nstatus: accepted\nnormative: true\ndate: 2026-01-01\nsuperseded_by: ADR-002',
    )

    expect(migrateAdrFile(path).warnings).toContainEqual(expect.stringContaining('but status is'))
  })

  it('prefers the first-commit date over a date scraped from a retirement line', () => {
    // "Superseded — 2026-08-24" dates the *retirement*. Recording it as `date`
    // backdates the ADR's authorship to its own death, silently, and the
    // template defines `date` as the decision date. It hit ADR-015 in the PR
    // that introduced the contract and was caught by hand; a consumer gets no
    // such review.
    const path = writeAdr(
      '002-b.mdx',
      'title: t\ndescription: d',
      '\n## Status\n\nSuperseded — 2026-08-24 by ADR-003\n\n## Context\n\nx\n',
    )
    const report = migrateAdrFile(path, { dates: { [path]: '2026-02-01' } })

    expect(report.date).toBe('2026-02-01')
    expect(parseFrontmatter(readFileSync(path, 'utf-8')).date).toBe('2026-02-01')
  })

  it('still reads a decision date off an in-force status line', () => {
    const path = writeAdr(
      '001-a.mdx',
      'title: t\ndescription: d',
      '\n## Status\n\nAccepted 2026-01-05. Narrowed 2026-09-21 by ADR-020.\n\n## Context\n\nx\n',
    )

    expect(migrateAdrFile(path, { dates: { [path]: '2026-02-01' } }).date).toBe('2026-01-05')
  })

  it('flags a decision date later than the retirement it precedes', () => {
    const path = writeAdr(
      '002-b.mdx',
      'title: t\ndescription: d',
      '\n## Status\n\nSuperseded — 2026-01-02 by ADR-003\n\n## Context\n\nx\n',
    )
    const report = migrateAdrFile(path, { dates: { [path]: '2026-09-01' } })

    expect(report.warnings).toContainEqual(expect.stringContaining('is after the superseded date'))
  })

  it('canonicalises an aliased axial declaration instead of leaving it invisible', () => {
    const path = writeAdr(
      '001-axis.md',
      'title: t\ndescription: d\nstatus: accepted\nnormative: true\ndate: 2026-01-01\naxial: True',
    )
    const report = migrateAdrFile(path)

    expect(report.warnings).toContainEqual(expect.stringContaining('boolean alias'))
    expect(parseFrontmatter(readFileSync(path, 'utf-8')).axial).toBe('true')
  })
})

describe('partial supersession', () => {
  it('reads "Partially superseded by ADR-015" as a qualifier, not a replacement', () => {
    const reading = interpretStatusLine(
      'Accepted. **Partially superseded by [ADR-015](015-x.mdx) for the TypeScript layer**.',
    )

    expect(reading?.status).toBe('accepted')
    expect(reading?.supersededBy).toBeNull()
    expect(reading?.supersededInPartBy).toEqual(['ADR-015'])
  })

  it('reads "Narrowed YYYY-MM-DD by ADR-020"', () => {
    expect(interpretStatusLine('Accepted — 2026-08-21. Narrowed 2026-09-21 by ADR-020.')?.supersededInPartBy).toEqual([
      'ADR-020',
    ])
  })

  it('reads a change reference when no ADR recorded the retirement', () => {
    // ADR-003's own prose: the mechanism was removed by a PR and no ADR was
    // ever written. The field holds `#268` rather than forcing a successor
    // that does not exist — inventing one is how a decision log is falsified.
    expect(
      interpretStatusLine('Accepted. **Amended by #268** — the fieldIds bag was removed.')?.supersededInPartBy,
    ).toEqual(['#268'])
  })

  it('finds a qualifier on a later line of the status section', () => {
    // ADR-019's own shape: it opens "Accepted — 2026-08-21" and narrows itself
    // two lines down. Reading only the opening line dropped the qualifier and
    // still reported success — the exact loss this field exists to prevent.
    const path = writeAdr(
      '019-falsify.md',
      'title: t\ndescription: d',
      [
        '',
        '## Status',
        '',
        'Accepted — 2026-08-21. Implements Roxabi/roxabi-plugins#417 Shape 1 (V1).',
        '**Narrowed 2026-09-21 by ADR-020** — this ADR governs the Claude/Grok product only.',
        '',
        '## Context',
        '',
        'x',
        '',
      ].join('\n'),
    )
    const report = migrateAdrFile(path)

    expect(report.status).toBe('accepted')
    expect(report.date).toBe('2026-08-21')
    expect(report.supersededInPartBy).toEqual(['ADR-020'])
    expect(parseFrontmatter(readFileSync(path, 'utf-8')).superseded_in_part_by).toBe('[ADR-020]')
  })

  it('keeps the ADR in force, in place, and appends rather than replaces', () => {
    accepted('001', 'hex')
    supersedeAdrInPart(find(1), 'ADR-015')
    supersedeAdrInPart(find(1), '#452')

    const fields = parseFrontmatter(readFileSync(join(dir, '001-hex.md'), 'utf-8'))
    expect(fields.status).toBe('accepted')
    expect(fields.normative).toBe('true')
    expect(parseRefList(fields.superseded_in_part_by)).toEqual(['ADR-015', '#452'])
    expect(existsSync(join(dir, 'archived', '001-hex.md'))).toBe(false)
  })

  it('does not duplicate a reference already recorded', () => {
    accepted('001', 'hex')
    supersedeAdrInPart(find(1), 'ADR-015')
    supersedeAdrInPart(find(1), 'ADR-015')

    expect(
      parseRefList(parseFrontmatter(readFileSync(join(dir, '001-hex.md'), 'utf-8')).superseded_in_part_by),
    ).toEqual(['ADR-015'])
  })

  it('is stripped when the ADR is wholly replaced', () => {
    // "In force except X" is a contradiction on a record that is wholly gone.
    accepted('001', 'hex')
    supersedeAdrInPart(find(1), 'ADR-015')
    const result = supersedeAdr(find(1), 'ADR-002', dir)

    expect(parseFrontmatter(readFileSync(result.to, 'utf-8')).superseded_in_part_by).toBeUndefined()
  })

  it('is stripped when the ADR is deprecated', () => {
    accepted('001', 'hex')
    supersedeAdrInPart(find(1), 'ADR-015')
    deprecateAdr(find(1))

    expect(parseFrontmatter(readFileSync(join(dir, '001-hex.md'), 'utf-8')).superseded_in_part_by).toBeUndefined()
  })
})

describe('number integrity', () => {
  it('does not let a dated note set the next number', () => {
    // `2026-08-24-notes.md` beside 001-005 returned 2027, silently: `next` is
    // max + 1 over whatever the scan admits, and nothing questioned a maximum.
    for (const n of ['001', '002', '003', '004', '005']) accepted(n, `decision-${n}`)
    writeAdr('2026-08-24-notes.md', 'title: notes')

    expect(nextNnn(dir)).toBe('006')
    expect(misnamedAdrs(dir)).toEqual([join(dir, '2026-08-24-notes.md')])
  })

  it('does not admit a file whose prefix is not a padded number', () => {
    accepted('001', 'first')
    writeAdr('12.md', 'title: t')
    writeAdr('00001-too-wide.md', 'title: t')

    expect(scanAdrs(dir).map((a) => a.name)).toEqual(['001-first.md'])
    expect(misnamedAdrs(dir)).toEqual([join(dir, '00001-too-wide.md'), join(dir, '12.md')])
  })

  it('finds one number claimed by two documents', () => {
    accepted('001', 'a')
    writeAdr('0001-b.md', 'title: t\nstatus: accepted\nnormative: true\ndate: 2026-01-01')

    expect(adrCollisions(dir)).toEqual([{ nnn: 1, files: [join(dir, '0001-b.md'), join(dir, '001-a.md')] }])
  })

  it('finds a collision across the archive boundary', () => {
    accepted('001', 'a')
    accepted('002', 'b')
    supersedeAdr(find(1), 'ADR-002', dir)
    accepted('001', 'reused')

    expect(adrCollisions(dir).map((c) => c.nnn)).toEqual([1])
  })

  it('reports no collision on a clean corpus', () => {
    for (const n of ['001', '002', '003']) accepted(n, `decision-${n}`)

    expect(adrCollisions(dir)).toEqual([])
    expect(misnamedAdrs(dir)).toEqual([])
  })
})

describe('axial reader', () => {
  it('sees a declaration written in any YAML boolean spelling', () => {
    // A repo whose axis is declared `axial: True` read as `declared: false` —
    // the exact signal `/R-dev-init` and the axial interview use to launch the
    // interview that writes a *second* axial ADR.
    for (const spelling of ['true', 'True', 'TRUE', 'yes', 'on']) {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      writeAdr('001-axis.md', `title: t\nstatus: accepted\nnormative: true\ndate: 2026-01-01\naxial: ${spelling}`)

      expect(axialAdrs(dir), spelling).toHaveLength(1)
    }
  })

  it('does not read a denial as a declaration', () => {
    for (const spelling of ['false', 'False', 'no', 'off']) {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      writeAdr('001-a.md', `title: t\nstatus: accepted\nnormative: true\ndate: 2026-01-01\naxial: ${spelling}`)

      expect(axialAdrs(dir), spelling).toHaveLength(0)
    }
  })

  it('strips an aliased marker when the ADR is archived', () => {
    writeAdr('001-axis.md', 'title: t\nstatus: accepted\nnormative: true\ndate: 2026-01-01\naxial: yes')
    const result = supersedeAdr(find(1), 'ADR-002', dir)

    expect(result.axialStripped).toBe(true)
    expect(axialAdrs(dir)).toHaveLength(0)
  })
})
