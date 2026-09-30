import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const ESBUILD = {
  id: 1120680,
  url: 'https://github.com/advisories/GHSA-g7r4-m6w7-qqqr',
  title: 'esbuild allows arbitrary file read when running the development server on Windows',
  severity: 'low',
  vulnerable_versions: '>=0.27.3 <0.28.1',
}
const ESBUILD_OTHER = { ...ESBUILD, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high' }
const JS_YAML = { ...ESBUILD, url: 'https://github.com/advisories/GHSA-2883-xcg3-v3hh', severity: 'high' }
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
    const two = marker(classify(advisories({ esbuild: [ESBUILD_OTHER], vite: [ESBUILD_OTHER] }), []))
    expect(two).not.toBe(one)
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

  it('renders registry text as inert code: no link, image or mention, even with no GHSA to link', () => {
    const hostile = {
      ...ESBUILD_OTHER,
      // No GHSA at the end, so there is no id to link: the url itself must not become one.
      url: 'https://evil.example/[GHSA-aaaa-bbbb-cccc](https://evil.example)',
      // A `\` before a `|` must not cancel its escape. GFM treats a `|` right after a `\` as
      // cell text however many `\` precede it: checked against GitHub's renderer, this row
      // keeps five cells and shows the title as one code span, `\|` included.
      title: 'ping @octocat ![x](https://evil.example/i.png) `` fence \\| [x](https://evil.example)',
    }
    const report = renderReport(classify(advisories({ '@foo/bar': [hostile] }), [], ['@foo/baz']), [], META)
    expect(rows(report)).toEqual([
      '| ` @foo/bar ` | high | ` https://evil.example/[GHSA-aaaa-bbbb-cccc](https://evil.example) ` | ' +
        '``` ping @octocat ![x](https://evil.example/i.png) `` fence \\\\| [x](https://evil.example) ``` | ` >=0.27.3 <0.28.1 ` |',
    ])
    expect(report).toContain('\n- ` @foo/baz `\n')
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dependency-audit-'))
    report = join(dir, 'report.md')
    spawn = vi.spyOn(Bun, 'spawnSync')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  // Route tests pass their own ignore list: the shipped IGNORED must never be the reason
  // a route test passes. Only the next test is tied to it, on purpose.
  it('exits 10 on a finding and writes a report whose first line is the marker', () => {
    bunAudit(JSON.stringify({ 'js-yaml': [JS_YAML], esbuild: [ESBUILD] }), 1)
    expect(main(['--report', report], {}, [IGNORE])).toBe(10)
    const [first] = readFileSync(report, 'utf8').split('\n')
    const found = classify(advisories({ 'js-yaml': [JS_YAML], esbuild: [ESBUILD] }), [IGNORE])
    expect(first).toBe(`<!-- dependency-audit: ${marker(found)} -->`)
    expect(first).not.toContain('g7r4')
  })

  it('exits 0 when the only advisory is one the shipped IGNORED accepts, and writes no report', () => {
    bunAudit(JSON.stringify({ esbuild: [ESBUILD] }), 1)
    expect(main(['--report', report], {})).toBe(0)
    expect(existsSync(report)).toBe(false)
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
