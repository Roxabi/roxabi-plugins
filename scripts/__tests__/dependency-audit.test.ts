import type * as NodeFs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type Advisory,
  AuditOutputError,
  classify,
  type Ignore,
  main,
  marker,
  parseAudit,
  renderReport,
} from '../dependency-audit'

// The workflow files a security issue on exit 10 and stays silent on exit 0, so the two
// costly bugs are a false clean (an unreadable audit, a skipped package, or an ignore that
// hides too much) and a false alarm (an ignored advisory reported, or the same report
// re-posted weekly). `bun audit` itself is spied: a unit test must not fork (#502).

// `main` writes to fd 1 directly, past vitest's console capture: the write is mocked so a
// test reads what reached stdout instead of the run printing it.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  writeSync: vi.fn(),
}))

const ESBUILD = {
  id: 1120680,
  url: 'https://github.com/advisories/GHSA-g7r4-m6w7-qqqr',
  title: 'esbuild allows arbitrary file read when running the development server on Windows',
  severity: 'low',
  vulnerable_versions: '>=0.27.3 <0.28.1',
}
// Each fixture advisory has its own bun id, as bun reports one per package advisory: the same
// GHSA in another package (VITE_ESBUILD) is another advisory, with another id. A test that
// wants two advisories to share an id gives them the same one on purpose.
const ESBUILD_OTHER = {
  ...ESBUILD,
  id: 1120681,
  url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
  severity: 'high',
}
const JS_YAML = { ...ESBUILD, id: 1120682, url: 'https://github.com/advisories/GHSA-2883-xcg3-v3hh', severity: 'high' }
const VITE_ESBUILD = { ...ESBUILD, id: 1120683 }
const IGNORE: Ignore = {
  ghsa: 'GHSA-g7r4-m6w7-qqqr',
  package: 'esbuild',
  severity: 'low',
  reason: 'test',
  removeWhen: 'test',
}
// bun 1.4.0's real warning (FORCE_COLOR=1): one line per registry, its packages joined by ', '.
// The second registry line uses bun's other wording, which carries no status.
const SKIP_WARNING =
  '\u001b[33mwarn\u001b[0m\u001b[2m:\u001b[0m http://127.0.0.1:48646 did not answer the audit request (404); ' +
  'skipped @foo/bar, @foo/baz, @foo/qux\n' +
  '\u001b[33mwarn\u001b[0m\u001b[2m:\u001b[0m http://127.0.0.1:48647 did not answer the audit request; ' +
  'skipped @bar/one, @bar/two\n'

const advisories = (report: Record<string, unknown[]>): Advisory[] => parseAudit(JSON.stringify(report))

// Literal JSON is essential: JSON.stringify would discard the duplicate before the parser sees it.
const DUPLICATE_ID_AUDIT = `{
  "esbuild": [{
    "id": 1120680, "url": "https://github.com/advisories/GHSA-g7r4-m6w7-qqqr",
    "title": "accepted", "severity": "low"
  }],
  "vite": [{
    "id": 1120680, "id": null, "url": "https://github.com/advisories/GHSA-2883-xcg3-v3hh",
    "title": "finding", "severity": "high"
  }]
}`

describe('parseAudit', () => {
  it.each([
    ['an error body bun echoes with exit 0', '{"error":"rate limited"}'],
    ['the empty stdout bun prints on an error', ''],
    ['a top-level array', '[]'],
    ['null', 'null'],
    ['a package with no advisory', '{"esbuild":[]}'],
    [
      'an advisory without a url, which would dodge the ignore match',
      JSON.stringify({ esbuild: [{ ...ESBUILD, url: undefined }] }),
    ],
    ['an advisory without a title', JSON.stringify({ esbuild: [{ ...ESBUILD, title: undefined }] })],
    ['a severity it does not know', JSON.stringify({ esbuild: [{ ...ESBUILD, severity: 'info' }] })],
  ])('refuses %s', (_, stdout) => {
    expect(() => parseAudit(stdout)).toThrow(AuditOutputError)
  })

  it.each([
    ['a valid id followed by null', DUPLICATE_ID_AUDIT],
    [
      'an escaped-equivalent key',
      String.raw`{"vite":[{"id":1120680,"\u0069d":null,"url":"https://x","title":"finding","severity":"high"}]}`,
    ],
    ['a duplicate package', `{"vite":${JSON.stringify([ESBUILD_OTHER])},"vite":${JSON.stringify([ESBUILD])}}`],
    ['a duplicate nested key', `{"vite":[{${JSON.stringify(ESBUILD_OTHER).slice(1, -1)},"metadata":{"x":1,"x":2}}]}`],
  ])('rejects ambiguous duplicate object keys: %s', (_, raw) => {
    expect(() => parseAudit(raw)).toThrow(AuditOutputError)
  })

  it('keeps repeated keys in separate objects and duplicate-looking text inside string values', () => {
    const title = String.raw`an "id":1,"id":null example with braces {} and an escaped quote \"`
    const parsed = advisories({ vite: [{ ...ESBUILD_OTHER, title }], esbuild: [ESBUILD] })
    expect(parsed.map((a) => [a.package, a.title])).toEqual([
      ['vite', title],
      ['esbuild', ESBUILD.title],
    ])
  })

  it.each([
    ['a safe integer', 1120680, 1120680],
    ['a missing id', undefined, null],
    ['a null id', null, null],
    ['a string id', '1120680', null],
    ['a fractional id', 1.5, null],
    ['an id past the safe integers', 2 ** 53, null],
    ['zero', 0, null],
    ['a negative id', -2, null],
  ])('reads the advisory id from %s', (_, id, expected) => {
    const [a] = advisories({ esbuild: [{ ...ESBUILD, id }] })
    expect(a.id).toBe(expected)
  })

  // bun's `parse_vulnerability`: a string id verbatim, a number as a saturating `f64 as u64`, else empty.
  it.each<[string, unknown, string]>([
    ['a string id, verbatim', '500', '500'],
    ['a string that is no number, verbatim', 'GHSA-x', 'GHSA-x'],
    ['a number', 1120680, '1120680'],
    ['a fraction, truncated', 1.5, '1'],
    ['a negative number, saturated to 0', -2, '0'],
    ['zero', 0, '0'],
    ['a number past the safe integers', 2 ** 53, '9007199254740992'],
    ['a number past u64, saturated', 1e30, '18446744073709551615'],
    ['a missing id', undefined, ''],
    ['a null id', null, ''],
    ['an object id', {}, ''],
  ])('reads the id text bun compares from %s', (_, id, expected) => {
    const [a] = advisories({ esbuild: [{ ...ESBUILD, id }] })
    expect(a.bunId).toBe(expected)
  })

  it.each([
    ['not an array', 5],
    ['a non-object advisory', [5]],
    ['an advisory without fields', [{}]],
  ])('keeps a registry-chosen package name on one log line when the entry is %s', (_, entry) => {
    // A raw newline would start a log line of the registry's choosing, which the Actions
    // runner reads as a workflow command.
    const thrown = (() => {
      try {
        parseAudit(JSON.stringify({ 'x\n::warning::pwned\ny': entry }))
      } catch (error) {
        return error
      }
    })()
    expect(thrown).toBeInstanceOf(AuditOutputError)
    expect((thrown as Error).message).toContain('x\\n::warning::pwned\\ny')
    expect((thrown as Error).message).not.toContain('\n')
  })
})

describe('classify', () => {
  it('suppresses an ignored advisory and reports nothing', () => {
    const c = classify(advisories({ esbuild: [ESBUILD] }), [IGNORE])
    expect(c).toMatchObject({ findings: [], stale: [], unaudited: [] })
    expect(c.suppressed.map((a) => a.ghsa)).toEqual(['GHSA-g7r4-m6w7-qqqr'])
  })

  it('reports an ignore as stale once its advisory leaves the tree', () => {
    const c = classify([], [IGNORE])
    expect(c.stale).toEqual([IGNORE])
    expect(c.findings).toEqual([])
  })

  it('does not let an ignore suppress the same advisory in another package', () => {
    const c = classify(advisories({ vite: [ESBUILD] }), [IGNORE])
    expect(c.findings.map((a) => `${a.package}:${a.ghsa}`)).toEqual(['vite:GHSA-g7r4-m6w7-qqqr'])
    expect(c.stale).toEqual([IGNORE])
  })

  it.each([
    ['up', 'low', 'high'],
    ['down', 'high', 'moderate'],
  ])('reports an ignored advisory re-rated %s, and keeps the ignore live', (_, accepted, now) => {
    const c = classify(advisories({ esbuild: [{ ...ESBUILD, severity: now }] }), [
      { ...IGNORE, severity: accepted as Ignore['severity'] },
    ])
    expect(c.findings.map((a) => `${a.ghsa}:${a.severity}`)).toEqual([`GHSA-g7r4-m6w7-qqqr:${now}`])
    expect(c.stale).toEqual([])
  })

  it('reports the other advisories of an ignored package', () => {
    const c = classify(advisories({ esbuild: [ESBUILD, ESBUILD_OTHER] }), [IGNORE])
    expect(c.findings.map((a) => a.ghsa)).toEqual(['GHSA-aaaa-bbbb-cccc'])
  })
})

describe('marker', () => {
  it('does not depend on the order bun lists packages in', () => {
    const a = marker(classify(advisories({ esbuild: [ESBUILD_OTHER], 'js-yaml': [JS_YAML] }), []))
    const b = marker(classify(advisories({ 'js-yaml': [JS_YAML], esbuild: [ESBUILD_OTHER] }), []))
    expect(a).toBe(b)
  })

  it('changes when a finding is re-rated', () => {
    const before = marker(classify(advisories({ esbuild: [ESBUILD_OTHER] }), []))
    const after = marker(classify(advisories({ esbuild: [{ ...ESBUILD_OTHER, severity: 'critical' }] }), []))
    expect(after).not.toBe(before)
  })

  it('is non-empty for a report made only of stale ignores or only of unaudited packages', () => {
    expect(marker(classify([], [IGNORE]))).not.toBe('')
    expect(marker(classify([], [], ['@foo/bar']))).not.toBe('')
  })

  it('changes with the stale entry or the skipped package it reports', () => {
    const stale = marker(classify([], [IGNORE]))
    expect(marker(classify([], [{ ...IGNORE, ghsa: 'GHSA-aaaa-bbbb-cccc' }]))).not.toBe(stale)
    expect(marker(classify([], [{ ...IGNORE, package: 'vite' }]))).not.toBe(stale)
    const skipped = marker(classify([], [], ['@foo/bar']))
    expect(marker(classify([], [], ['@foo/baz']))).not.toBe(skipped)
    expect(skipped).not.toBe(stale)
  })

  it('changes when the same advisory reaches one more package', () => {
    const one = marker(classify(advisories({ esbuild: [ESBUILD_OTHER] }), []))
    const two = marker(
      classify(advisories({ esbuild: [ESBUILD_OTHER], vite: [{ ...ESBUILD_OTHER, id: 1120684 }] }), []),
    )
    expect(two).not.toBe(one)
  })

  const keys = (m: string) => (m === '' ? [] : m.split(',')).sort()
  const AUDIT = { 'js-yaml': [JS_YAML], esbuild: [ESBUILD] }
  const STALE_VITE: Ignore = { ...IGNORE, package: 'vite' }

  it('carries one ignore key per accepted id, beside the finding keys, when the report prints a fix command', () => {
    expect(keys(marker(classify(advisories(AUDIT), [IGNORE])))).toEqual([
      'ignore:1120680',
      'js-yaml:GHSA-2883-xcg3-v3hh:high',
    ])
  })

  it('carries an id-less key for an accepted advisory bun sent no usable id for, and no ignore key for it', () => {
    const audit = { 'js-yaml': [JS_YAML], esbuild: [{ ...ESBUILD, id: null }] }
    expect(keys(marker(classify(advisories(audit), [IGNORE])))).toEqual([
      'idless:esbuild:GHSA-g7r4-m6w7-qqqr',
      'js-yaml:GHSA-2883-xcg3-v3hh:high',
    ])
  })

  it('carries one id-less key per accepted advisory: two GHSAs of one package are two keys', () => {
    const other: Ignore = { ...IGNORE, ghsa: 'GHSA-aaaa-bbbb-cccc' }
    const audit = {
      'js-yaml': [JS_YAML],
      esbuild: [
        { ...ESBUILD, id: null },
        { ...ESBUILD_OTHER, id: null, severity: 'low' },
      ],
    }
    expect(keys(marker(classify(advisories(audit), [IGNORE, other])))).toEqual([
      'idless:esbuild:GHSA-aaaa-bbbb-cccc',
      'idless:esbuild:GHSA-g7r4-m6w7-qqqr',
      'js-yaml:GHSA-2883-xcg3-v3hh:high',
    ])
  })

  it('carries no ignore or id-less key on a report with no finding', () => {
    // The accepted advisory is suppressed and a stale entry is reported: no fix command is printed.
    expect(keys(marker(classify(advisories({ esbuild: [ESBUILD] }), [IGNORE, STALE_VITE])))).toEqual([
      'stale:vite:GHSA-g7r4-m6w7-qqqr',
    ])
    expect(keys(marker(classify(advisories({ esbuild: [{ ...ESBUILD, id: null }] }), [IGNORE, STALE_VITE])))).toEqual([
      'stale:vite:GHSA-g7r4-m6w7-qqqr',
    ])
    expect(keys(marker(classify(advisories({ esbuild: [ESBUILD] }), [IGNORE], ['@foo/bar'])))).toEqual([
      expect.stringMatching(/^unaudited:/),
    ])
  })

  it('is unchanged when only accepted keys change on a report with no finding', () => {
    const before = marker(classify(advisories({ esbuild: [ESBUILD] }), [IGNORE, STALE_VITE]))
    const idChanged = marker(classify(advisories({ esbuild: [{ ...ESBUILD, id: 7 }] }), [IGNORE, STALE_VITE]))
    const idLost = marker(classify(advisories({ esbuild: [{ ...ESBUILD, id: null }] }), [IGNORE, STALE_VITE]))
    expect(idChanged).toBe(before)
    expect(idLost).toBe(before)
  })

  it('changes when only the id behind a printed flag changes, or when that id goes missing', () => {
    const marked = (esbuild: unknown) =>
      marker(classify(advisories({ 'js-yaml': [JS_YAML], esbuild: [esbuild] }), [IGNORE]))
    const before = marked(ESBUILD)
    expect(marked({ ...ESBUILD, id: 7 })).not.toBe(before)
    expect(marked({ ...ESBUILD, id: null })).not.toBe(before)
    expect(marked({ ...ESBUILD, id: null })).not.toBe(marked({ ...ESBUILD, id: 7 }))
  })

  it.each(['url', 'id'] as const)(
    'changes when a collision changes the printed command with unchanged finding identity: %s',
    (collision) => {
      const url = 'https://example.test/safe/GHSA-2883-xcg3-v3hh'
      const finding = { ...JS_YAML, id: 300, url }
      const colliding =
        collision === 'url'
          ? { ...finding, url: 'https://example.test/200/GHSA-2883-xcg3-v3hh' }
          : { ...finding, id: 200 }
      const accepted = { ...ESBUILD, id: 200 }
      const before = classify(advisories({ esbuild: [accepted], 'js-yaml': [finding] }), [IGNORE])
      const after = classify(advisories({ esbuild: [accepted], 'js-yaml': [colliding] }), [IGNORE])
      const meta = { ref: 'main', sha: '0123456789', runUrl: null, bunVersion: 'test' }

      expect(renderReport(before, [IGNORE], meta)).toContain('`bun audit fix --ignore=200`')
      const changedReport = renderReport(after, [IGNORE], meta)
      expect(changedReport).toContain('`bun audit fix`')
      expect(changedReport).not.toContain('--ignore=200')
      expect(keys(marker(before))).toEqual(['ignore:200', 'js-yaml:GHSA-2883-xcg3-v3hh:high'])
      expect(keys(marker(after))).toEqual(['idless:esbuild:GHSA-g7r4-m6w7-qqqr', 'js-yaml:GHSA-2883-xcg3-v3hh:high'])
    },
  )

  it('is unchanged when the printed command is, whatever else the accepted advisory sends', () => {
    const reworded = { ...ESBUILD, title: 'reworded', vulnerable_versions: '<0.28.1' }
    expect(marker(classify(advisories({ esbuild: [reworded], 'js-yaml': [JS_YAML] }), [IGNORE]))).toBe(
      marker(classify(advisories(AUDIT), [IGNORE])),
    )
  })

  it('changes when only the accepted set behind the fix command changes', () => {
    const before = marker(classify(advisories({ 'js-yaml': [JS_YAML] }), []))
    const after = marker(classify(advisories({ 'js-yaml': [JS_YAML], esbuild: [ESBUILD] }), [IGNORE]))
    expect(after).not.toBe(before)
  })

  it('stays inside the alphabet the workflow parses back, whatever the registry sends', () => {
    const hostile = { ...ESBUILD_OTHER, url: 'https://x/1-->\n## pwned <img src=x>' }
    const report = advisories({ esbuild: [hostile], 'evil-->\n<b>': [ESBUILD_OTHER] })
    expect(marker(classify(report, [], ['a --> b']))).toMatch(/^[A-Za-z0-9@/._:,-]+$/)
  })
})

describe('renderReport', () => {
  const META = { ref: 'main', sha: '0123456789', runUrl: null, bunVersion: 'test' }
  const rows = (report: string) => report.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Package'))

  it('builds the advisory link from the GHSA, never from the url field, and keeps each row one row', () => {
    const hostile = {
      ...ESBUILD_OTHER,
      url: 'javascript:alert(1)/GHSA-aaaa-bbbb-cccc',
      title: 'a | b <img src=x>\n## injected',
    }
    const report = renderReport(classify(advisories({ esbuild: [hostile] }), []), [], META)
    expect(report).toContain('[GHSA-aaaa-bbbb-cccc](https://github.com/advisories/GHSA-aaaa-bbbb-cccc)')
    expect(report).toContain('| ` a \\| b <img src=x> ## injected ` |')
    expect(report).not.toContain('javascript:')
    expect(report).not.toMatch(/^## injected/m)
  })

  it('renders registry text and the ref as inert code: no link, image or mention, even with no GHSA to link', () => {
    const hostile = {
      ...ESBUILD_OTHER,
      // No GHSA at the end, so there is no id to link: the url itself must not become one.
      url: 'https://evil.example/[GHSA-aaaa-bbbb-cccc](https://evil.example)',
      // A `\` before a `|` must not cancel its escape. GFM treats a `|` right after a `\` as
      // cell text however many `\` precede it: checked against GitHub's renderer, this row
      // keeps five cells and shows the title as one code span, `\|` included.
      title: 'ping @octocat ![x](https://evil.example/i.png) `` fence \\| [x](https://evil.example)',
    }
    const ref = 'feat/`x` [y](https://evil.example)'
    const report = renderReport(classify(advisories({ '@foo/bar': [hostile] }), [], ['@foo/baz']), [], { ...META, ref })
    expect(rows(report)).toEqual([
      '| ` @foo/bar ` | high | ` https://evil.example/[GHSA-aaaa-bbbb-cccc](https://evil.example) ` | ' +
        '``` ping @octocat ![x](https://evil.example/i.png) `` fence \\\\| [x](https://evil.example) ``` | ` >=0.27.3 <0.28.1 ` |',
    ])
    expect(report).toContain('\n- ` @foo/baz `\n')
    expect(report).toContain('\nRef `` feat/`x` [y](https://evil.example) `` · ` 01234567 ` · bun test\n')
  })
})

// bun's `--ignore=<v>` spares an advisory when its id text equals `v` or its url contains `v`,
// for every advisory of every package (`keep_vulnerability` and `parse_vulnerability` in
// `src/runtime/cli/audit_command.rs` at tags bun-v1.4.0 and bun-v1.4.3). The command is
// computed against that rule: it carries `--ignore=<n>` for an accepted advisory only when `n`
// is a positive safe integer that spares no finding, and lists every accepted advisory it
// leaves without a flag. `--ignore=<GHSA>` is never emitted: it spares every package sharing
// the GHSA and any url holding it. The copied command must spare every accepted advisory it
// can and no finding: a missing flag retires an accepted advisory, an extra one hides a finding.
describe('the fix command', () => {
  const META = { ref: 'main', sha: '0123456789', runUrl: null, bunVersion: 'test' }
  const OTHER_IGNORE: Ignore = { ...IGNORE, ghsa: 'GHSA-aaaa-bbbb-cccc', package: 'vite', severity: 'high' }
  const VITE_IGNORE: Ignore = { ...IGNORE, package: 'vite' }
  const render = (audit: Record<string, unknown[]>, ignored: Ignore[]) =>
    renderReport(classify(advisories(audit), ignored), ignored, META)
  const commands = (report: string) => {
    const fix = report.split('\n').find((l) => l.startsWith('Fix:')) ?? ''
    return [...fix.matchAll(/`(bun audit fix[^`]*)`/g)].map((m) => m[1])
  }
  const notSpared = (report: string) => report.split('\n').filter((l) => l.startsWith('Not spared'))

  it.each<{ name: string; audit: Record<string, unknown[]>; ignored: Ignore[]; flags: string }>([
    {
      name: 'an accepted advisory, by its id',
      audit: { esbuild: [ESBUILD], 'js-yaml': [JS_YAML] },
      ignored: [IGNORE],
      flags: ' --ignore=1120680',
    },
    {
      name: 'every accepted advisory, ids ascending whatever order bun lists packages in',
      audit: { vite: [ESBUILD_OTHER], esbuild: [ESBUILD], 'js-yaml': [JS_YAML] },
      ignored: [OTHER_IGNORE, IGNORE],
      flags: ' --ignore=1120680 --ignore=1120681',
    },
    {
      name: 'ids of different lengths in numeric order, not as text',
      audit: {
        p100: [{ ...ESBUILD, id: 100 }],
        p9: [{ ...ESBUILD, id: 9 }],
        p10: [{ ...ESBUILD, id: 10 }],
        'js-yaml': [JS_YAML],
      },
      ignored: [
        { ...IGNORE, package: 'p9' },
        { ...IGNORE, package: 'p10' },
        { ...IGNORE, package: 'p100' },
      ],
      flags: ' --ignore=9 --ignore=10 --ignore=100',
    },
    {
      name: 'only the accepted package when a finding shares its GHSA',
      audit: { esbuild: [ESBUILD], vite: [VITE_ESBUILD] },
      ignored: [IGNORE],
      flags: ' --ignore=1120680',
    },
    {
      name: 'one id per package when one GHSA is accepted in two',
      audit: { vite: [VITE_ESBUILD], esbuild: [ESBUILD], 'js-yaml': [JS_YAML] },
      ignored: [IGNORE, VITE_IGNORE],
      flags: ' --ignore=1120680 --ignore=1120683',
    },
    {
      name: 'a repeated id once',
      audit: { esbuild: [ESBUILD], vite: [ESBUILD], 'js-yaml': [JS_YAML] },
      ignored: [IGNORE, VITE_IGNORE],
      flags: ' --ignore=1120680',
    },
    {
      name: 'no re-rated advisory',
      audit: { esbuild: [{ ...ESBUILD, severity: 'high' }], 'js-yaml': [JS_YAML] },
      ignored: [IGNORE],
      flags: '',
    },
    { name: 'no stale ignore', audit: { 'js-yaml': [JS_YAML] }, ignored: [IGNORE], flags: '' },
  ])('is the within-range and the --latest command, each sparing $name', ({ audit, ignored, flags }) => {
    const report = render(audit, ignored)
    expect(commands(report)).toEqual([`bun audit fix${flags}`, `bun audit fix${flags} --latest`])
    expect(notSpared(report)).toEqual([])
  })

  it('spares the accepted advisory, and not the finding, whose url carries the accepted GHSA before a suffix', () => {
    const finding = { ...VITE_ESBUILD, url: 'https://github.com/advisories/GHSA-g7r4-m6w7-qqqr?ref=x' }
    const report = render({ esbuild: [ESBUILD], vite: [finding] }, [IGNORE])
    expect(report).toContain('| ` vite ` | low |')
    expect(commands(report)).toEqual(['bun audit fix --ignore=1120680', 'bun audit fix --ignore=1120680 --latest'])
    for (const command of commands(report)) {
      expect(command).not.toContain('GHSA')
      expect(command).not.toContain(String(finding.id))
    }
  })

  it.each([
    ['no id', null],
    ['an id past the safe integers', 2 ** 53],
    ['a string id', '1120680'],
  ])('puts no flag on an accepted advisory with %s, and names it on a line beside the fix command', (_, id) => {
    const report = render({ esbuild: [{ ...ESBUILD, id }], 'js-yaml': [JS_YAML] }, [IGNORE])
    expect(commands(report)).toEqual(['bun audit fix', 'bun audit fix --latest'])
    const [line, ...rest] = notSpared(report)
    expect(rest).toEqual([])
    expect(line).toContain('` esbuild `')
    expect(line).toContain('GHSA-g7r4-m6w7-qqqr')
    expect(line).toMatch(/no usable advisory id/)
    expect(line).toContain('bun audit fix --dry-run')
    expect(line).toContain('bun.lock')
    const lines = report.split('\n')
    expect(lines.indexOf(line)).toBe(lines.findIndex((l) => l.startsWith('Fix:')) + 1)
  })

  it('keeps the flag of an accepted advisory that has an id, beside the line of one that has none', () => {
    const ignored = [IGNORE, OTHER_IGNORE]
    const report = render({ esbuild: [{ ...ESBUILD, id: null }], vite: [ESBUILD_OTHER], 'js-yaml': [JS_YAML] }, ignored)
    expect(commands(report)).toEqual(['bun audit fix --ignore=1120681', 'bun audit fix --ignore=1120681 --latest'])
    expect(notSpared(report)).toHaveLength(1)
    expect(notSpared(report)[0]).toContain('` esbuild `')
  })

  describe('an accepted id that would also spare a finding', () => {
    const accepted = { ...ESBUILD, id: 200 }
    it.each<{ name: string; finding: Record<string, unknown> }>([
      {
        name: 'whose url holds the id',
        finding: { ...ESBUILD_OTHER, id: 300, url: 'https://example.test/advisories/200' },
      },
      {
        name: 'whose url holds the id before a query suffix',
        finding: { ...ESBUILD_OTHER, id: 300, url: 'https://example.test/advisories/200?ref=x' },
      },
      {
        name: 'whose url holds the id inside a longer path segment',
        finding: { ...ESBUILD_OTHER, id: 300, url: 'https://example.test/a12003z/advisory' },
      },
      {
        name: 'whose url holds the id inside a fragment',
        finding: { ...ESBUILD_OTHER, id: 300, url: 'https://example.test/advisory#ref200tail' },
      },
      { name: 'that carries the same id', finding: { ...ESBUILD_OTHER, id: 200 } },
      { name: 'whose string id is the id text', finding: { ...ESBUILD_OTHER, id: '200' } },
    ])('carries no flag for it, beside a finding $name, and names the advisory and the finding', ({ finding }) => {
      const report = render({ esbuild: [accepted], vite: [finding] }, [IGNORE])
      expect(report).toContain('| ` vite ` | high |')
      expect(commands(report)).toEqual(['bun audit fix', 'bun audit fix --latest'])
      const [line, ...rest] = notSpared(report)
      expect(rest).toEqual([])
      expect(line).toContain('` esbuild ` (GHSA-g7r4-m6w7-qqqr)')
      expect(line).toContain('its id 200 would also spare ` vite `')
      expect(line).toContain('bun audit fix --dry-run')
      expect(line).toContain('bun.lock')
    })

    it('keeps the flag of a non-colliding accepted advisory beside the one it drops', () => {
      const dropped = { ...ESBUILD_OTHER, id: 200 }
      const finding = { ...JS_YAML, url: 'https://example.test/advisories/200' }
      const report = render({ esbuild: [ESBUILD], vite: [dropped], 'js-yaml': [finding] }, [IGNORE, OTHER_IGNORE])
      expect(commands(report)).toEqual(['bun audit fix --ignore=1120680', 'bun audit fix --ignore=1120680 --latest'])
      const [line, ...rest] = notSpared(report)
      expect(rest).toEqual([])
      expect(line).toContain('` vite ` (GHSA-aaaa-bbbb-cccc)')
      expect(line).toContain('` js-yaml `')
    })

    it('names every package whose finding the id would spare', () => {
      const finding = { ...JS_YAML, url: 'https://example.test/advisories/200' }
      const other = { ...JS_YAML, id: 200 }
      const [line] = notSpared(render({ esbuild: [accepted], 'js-yaml': [finding], 'a-lib': [other] }, [IGNORE]))
      expect(line).toContain('would also spare ` a-lib `, ` js-yaml `,')
    })
  })

  it.each([
    ['zero', 0],
    ['a negative id', -7],
  ])('puts no flag on an accepted advisory with %s', (_, id) => {
    const report = render({ esbuild: [{ ...ESBUILD, id }], 'js-yaml': [JS_YAML] }, [IGNORE])
    expect(commands(report)).toEqual(['bun audit fix', 'bun audit fix --latest'])
    expect(notSpared(report)).toHaveLength(1)
  })

  it('lists an accepted advisory once per package and GHSA, sorted by package then GHSA, whatever order bun lists them in', () => {
    const idless = { ...ESBUILD, id: null }
    const first = { ...ESBUILD_OTHER, id: null, severity: 'low' }
    const other: Ignore = { ...IGNORE, ghsa: 'GHSA-aaaa-bbbb-cccc' }
    const audit = { vite: [idless], esbuild: [idless, idless, first], 'js-yaml': [JS_YAML] }
    const report = render(audit, [IGNORE, VITE_IGNORE, other])
    expect(notSpared(report).map((l) => l.match(/` (\w+) ` \((GHSA-[\w-]+)\)/)?.slice(1))).toEqual([
      ['esbuild', 'GHSA-aaaa-bbbb-cccc'],
      ['esbuild', 'GHSA-g7r4-m6w7-qqqr'],
      ['vite', 'GHSA-g7r4-m6w7-qqqr'],
    ])
  })

  it('prints neither a fix command nor an id-less line when the report has no finding', () => {
    const report = render({ esbuild: [{ ...ESBUILD, id: null }] }, [IGNORE, VITE_IGNORE])
    expect(report).toContain('### Stale ignores')
    expect(commands(report)).toEqual([])
    expect(notSpared(report)).toEqual([])
  })
})

describe('main', () => {
  let dir: string
  let report: string
  let spawn: ReturnType<typeof vi.spyOn>

  // bun 1.4.0 leaves signalCode undefined on a child that exited, and sets it on a signal.
  const bunAudit = (stdout: string, exitCode: number | null, stderr = '', signalCode?: string) =>
    spawn.mockReturnValue({
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(stderr),
      exitCode,
      signalCode,
    } as unknown as Bun.SyncSubprocess<'pipe', 'pipe'>)

  // What `main` wrote to fd 1, and how many bytes one writeSync call takes.
  let stdoutBytes: Buffer[]
  let takes: number
  const stdout = () => Buffer.concat(stdoutBytes).toString()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dependency-audit-'))
    report = join(dir, 'report.md')
    spawn = vi.spyOn(Bun, 'spawnSync')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    stdoutBytes = []
    takes = Number.POSITIVE_INFINITY
    // mockReset, not mockClear: it also drops a once-implementation a test left unconsumed.
    vi.mocked(writeSync)
      .mockReset()
      .mockImplementation(((fd: number, data: Uint8Array, offset = 0) => {
        const n = Math.min(takes, data.byteLength - offset)
        if (fd === 1) stdoutBytes.push(Buffer.from(data.subarray(offset, offset + n)))
        return n
      }) as unknown as typeof writeSync)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  // Route tests pass their own ignore list: the shipped IGNORED must never be the reason
  // a route test passes. Only the next test is tied to it, on purpose.
  it('exits 10 on a finding and writes a report whose first line is the marker, to the file only', () => {
    bunAudit(JSON.stringify({ 'js-yaml': [JS_YAML], esbuild: [ESBUILD] }), 1)
    expect(main(['--report', report], {}, [IGNORE])).toBe(10)
    const [first] = readFileSync(report, 'utf8').split('\n')
    const found = classify(advisories({ 'js-yaml': [JS_YAML], esbuild: [ESBUILD] }), [IGNORE])
    expect(first).toBe(`<!-- dependency-audit: ${marker(found)} -->`)
    expect(first).not.toContain('g7r4')
    expect(stdout()).toBe('')
  })

  it('routes a duplicate-key audit response as untrusted without a report', () => {
    bunAudit(DUPLICATE_ID_AUDIT, 1)
    expect(main(['--report', report], {}, [IGNORE])).toBe(2)
    expect(existsSync(report)).toBe(false)
    expect(stdout()).not.toContain('Fix:')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('dependency-audit:'))
  })

  it('writes the same report to stdout when no --report is given', () => {
    bunAudit(JSON.stringify({ 'js-yaml': [JS_YAML] }), 1)
    expect(main(['--report', report], {}, [IGNORE])).toBe(10)
    expect(main([], {}, [IGNORE])).toBe(10)
    expect(stdout()).toBe(readFileSync(report, 'utf8'))
  })

  it('exits 0 when the only advisory is one the shipped IGNORED accepts, writes no report, and counts it on stdout', () => {
    bunAudit(JSON.stringify({ esbuild: [ESBUILD] }), 1)
    expect(main(['--report', report], {})).toBe(0)
    expect(existsSync(report)).toBe(false)
    expect(stdout()).toMatch(/\b1 ignored\b/)
  })

  it('routes on the ignore list it is given, not the shipped one', () => {
    // Under the shipped IGNORED, which does not accept js-yaml, the first call would exit 10;
    // so would the second, while IGNORED holds any entry.
    const acceptYaml: Ignore = { ...IGNORE, ghsa: 'GHSA-2883-xcg3-v3hh', package: 'js-yaml', severity: 'high' }
    bunAudit(JSON.stringify({ 'js-yaml': [JS_YAML] }), 1)
    expect(main(['--report', report], {}, [acceptYaml])).toBe(0)
    bunAudit('{}', 0)
    expect(main(['--report', report], {}, [])).toBe(0)
    expect(existsSync(report)).toBe(false)
  })

  it('exits 10 on an empty tree while an ignore still holds an entry for it', () => {
    bunAudit('{}', 0)
    expect(main(['--report', report], {}, [IGNORE])).toBe(10)
    expect(readFileSync(report, 'utf8')).toContain('### Stale ignores')
  })

  it.each([
    ['an empty stdout', '', 1, undefined],
    ['a non-audit JSON body', '{"error":"rate limited"}', 0, undefined],
    ['an empty report with exit 1', '{}', 1, undefined],
    ['advisories with exit 0', JSON.stringify({ 'js-yaml': [JS_YAML] }), 0, undefined],
    ['a child killed after flushing its JSON', JSON.stringify({ 'js-yaml': [JS_YAML] }), null, 'SIGTERM'],
    ['an exit code bun audit never uses', JSON.stringify({ 'js-yaml': [JS_YAML] }), 3, undefined],
  ])('exits 2 on %s and writes no report', (_, stdout, code, signal) => {
    bunAudit(stdout, code, '', signal)
    expect(main(['--report', report], {}, [IGNORE])).toBe(2)
    expect(existsSync(report)).toBe(false)
  })

  it('exits 10 when bun skipped a package, even though everything it did audit is accepted', () => {
    // The reproduced false clean: bun exits 1 on an accepted advisory and reports the skip on stderr only.
    bunAudit(JSON.stringify({ esbuild: [ESBUILD] }), 1, SKIP_WARNING)
    expect(main(['--report', report], {}, [IGNORE])).toBe(10)
    expect(readFileSync(report, 'utf8')).toContain(
      '\n- ` @foo/bar `\n- ` @foo/baz `\n- ` @foo/qux `\n- ` @bar/one `\n- ` @bar/two `\n',
    )
  })

  it('still exits 10 and writes the report when the step summary cannot be written', () => {
    bunAudit(JSON.stringify({ 'js-yaml': [JS_YAML], esbuild: [ESBUILD] }), 1)
    const env = { GITHUB_STEP_SUMMARY: join(dir, 'missing-dir', 'summary.md') }
    expect(main(['--report', report], env, [IGNORE])).toBe(10)
    expect(readFileSync(report, 'utf8')).toMatch(/^<!-- dependency-audit: /)
  })

  // A closed pipe (`… | head`) or a full non-blocking stdout makes writeSync throw. Once, so
  // the default implementation takes any later call.
  const stdoutThrows = () =>
    vi.mocked(writeSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' })
    })

  it('keeps exit 0 and says so when the clean summary cannot reach stdout', () => {
    bunAudit('{}', 0)
    stdoutThrows()
    expect(main(['--report', report], {}, [])).toBe(0)
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/stdout not written \(0 of \d+ bytes\): EPIPE/))
  })

  it('keeps exit 10 and says so when the report, with no --report, cannot reach stdout', () => {
    bunAudit(JSON.stringify({ 'js-yaml': [JS_YAML] }), 1)
    stdoutThrows()
    expect(main([], {}, [IGNORE])).toBe(10)
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/stdout not written \(0 of \d+ bytes\): EPIPE/))
  })

  it('writes the rest of a report that stdout takes a few bytes at a time', () => {
    bunAudit(JSON.stringify({ 'js-yaml': [JS_YAML] }), 1)
    expect(main(['--report', report], {}, [IGNORE])).toBe(10)
    takes = 7
    expect(main([], {}, [IGNORE])).toBe(10)
    expect(stdout()).toBe(readFileSync(report, 'utf8'))
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('stdout not written'))
  })

  it('keeps exit 10 and says how much was written when stdout fails part way', () => {
    bunAudit(JSON.stringify({ 'js-yaml': [JS_YAML] }), 1)
    takes = 7
    // The first call takes 7 bytes, the second throws.
    vi.mocked(writeSync).mockImplementationOnce(vi.mocked(writeSync).getMockImplementation() as typeof writeSync)
    stdoutThrows()
    expect(main([], {}, [IGNORE])).toBe(10)
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/stdout not written \(7 of \d+ bytes\): EPIPE/))
  })

  it('keeps exit 0 and reports once when stdout takes nothing', () => {
    bunAudit('{}', 0)
    takes = 0
    expect(main(['--report', report], {}, [])).toBe(0)
    expect(console.error).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/stdout not written \(0 of \d+ bytes\): write returned 0/),
    )
  })

  it('exits 2 and names the error when the report file, the workflow input, cannot be written', () => {
    bunAudit(JSON.stringify({ 'js-yaml': [JS_YAML] }), 1)
    expect(main(['--report', join(dir, 'missing-dir', 'report.md')], {}, [IGNORE])).toBe(2)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ENOENT'))
  })

  it('runs `audit --json` on the running bun, bounded well inside the audit step cap', () => {
    bunAudit('{}', 0)
    main(['--report', report], {}, [])
    const [argv, options] = spawn.mock.calls[0]
    expect(argv).toEqual([process.execPath, 'audit', '--json'])
    // A hung audit must end in the script's exit 2, so the failure issue carries an exit
    // code. The audit step's 6-minute cap is only the backstop, and the lock check and the
    // issue writes share it: at most half of it. At least a minute for one bulk request.
    expect(options.timeout).toBeGreaterThanOrEqual(60_000)
    expect(options.timeout).toBeLessThanOrEqual(3 * 60_000)
  })

  it('exits 2 on a bad argument without running bun audit', () => {
    expect(main(['--nope'], {}, [IGNORE])).toBe(2)
    expect(spawn).not.toHaveBeenCalled()
  })
})
