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
const SKIP_WARNING = 'warn: http://127.0.0.1:48645 did not answer the audit request (404); skipped @foo/bar\n'

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
})

describe('renderReport', () => {
  it('escapes table cells and builds the advisory link from the GHSA, never from the url field', () => {
    const hostile = {
      ...ESBUILD_OTHER,
      url: 'javascript:alert(1)/GHSA-aaaa-bbbb-cccc',
      title: 'a | b <img src=x>\n## injected',
    }
    const report = renderReport(classify(advisories({ esbuild: [hostile] }), []), [], {
      ref: 'main',
      sha: '0123456789',
      runUrl: null,
      bunVersion: 'test',
    })
    expect(report).toContain('[GHSA-aaaa-bbbb-cccc](https://github.com/advisories/GHSA-aaaa-bbbb-cccc)')
    expect(report).toContain('a \\| b &lt;img src=x> ## injected')
    expect(report).not.toContain('javascript:')
    expect(report).not.toMatch(/^## injected/m)
  })
})

describe('main', () => {
  let dir: string
  let report: string
  let spawn: ReturnType<typeof vi.spyOn>

  const bunAudit = (stdout: string, exitCode: number | null, stderr = '', signalCode: string | null = null) =>
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

  it('exits 10 on a finding and writes a report whose first line is the marker', () => {
    bunAudit(JSON.stringify({ 'js-yaml': [JS_YAML], esbuild: [ESBUILD] }), 1)
    expect(main(['--report', report], {})).toBe(10)
    const [first] = readFileSync(report, 'utf8').split('\n')
    expect(first).toMatch(/^<!-- dependency-audit: .+ -->$/)
    expect(first).not.toContain('g7r4')
  })

  it('exits 0 when the only advisory is one the shipped IGNORED accepts, and writes no report', () => {
    bunAudit(JSON.stringify({ esbuild: [ESBUILD] }), 1)
    expect(main(['--report', report], {})).toBe(0)
    expect(existsSync(report)).toBe(false)
  })

  it('exits 10 on an empty tree while the shipped IGNORED still holds an entry for it', () => {
    bunAudit('{}', 0)
    expect(main(['--report', report], {})).toBe(10)
    expect(readFileSync(report, 'utf8')).toContain('### Stale ignores')
  })

  it.each([
    ['an empty stdout', '', 1, null],
    ['a non-audit JSON body', '{"error":"rate limited"}', 0, null],
    ['an empty report with exit 1', '{}', 1, null],
    ['advisories with exit 0', JSON.stringify({ 'js-yaml': [JS_YAML] }), 0, null],
    ['a child killed after flushing its JSON', JSON.stringify({ 'js-yaml': [JS_YAML] }), null, 'SIGTERM'],
    ['an exit code bun audit never uses', JSON.stringify({ 'js-yaml': [JS_YAML] }), 3, null],
  ])('exits 2 on %s and writes no report', (_, stdout, code, signal) => {
    bunAudit(stdout, code, '', signal)
    expect(main(['--report', report], {})).toBe(2)
    expect(existsSync(report)).toBe(false)
  })

  it('exits 10 when bun skipped a package, even though its exit code and JSON say clean', () => {
    bunAudit('{}', 0, SKIP_WARNING)
    expect(main(['--report', report], {})).toBe(10)
    expect(readFileSync(report, 'utf8')).toContain('- @foo/bar')
  })

  it('exits 2 on a bad argument without running bun audit', () => {
    expect(main(['--nope'], {})).toBe(2)
    expect(spawn).not.toHaveBeenCalled()
  })
})
