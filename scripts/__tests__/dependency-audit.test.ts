import { describe, expect, it } from 'vitest'
import { type Advisory, AuditOutputError, classify, type Ignore, marker, parseAudit } from '../dependency-audit'

// The workflow files a security issue on exit 10 and stays silent on exit 0, so the two
// costly bugs are a false clean (an unreadable audit, or an ignore that hides too much)
// and a false alarm (an ignored advisory reported, or the same report re-posted weekly).

const ESBUILD = {
  id: 1120680,
  url: 'https://github.com/advisories/GHSA-g7r4-m6w7-qqqr',
  title: 'esbuild allows arbitrary file read when running the development server on Windows',
  severity: 'low',
  vulnerable_versions: '>=0.27.3 <0.28.1',
}
const ESBUILD_OTHER = { ...ESBUILD, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high' }
const IGNORE: Ignore = {
  ghsa: 'GHSA-g7r4-m6w7-qqqr',
  package: 'esbuild',
  severity: 'low',
  reason: 'test',
  removeWhen: 'test',
}

const advisories = (report: Record<string, unknown[]>): Advisory[] => parseAudit(JSON.stringify(report))

describe('parseAudit', () => {
  it('refuses an error body that bun echoes as JSON with exit 0', () => {
    expect(() => parseAudit('{"error":"rate limited"}')).toThrow(AuditOutputError)
  })

  it('refuses the empty stdout bun prints on an error', () => {
    expect(() => parseAudit('')).toThrow(AuditOutputError)
  })

  it('refuses an advisory without a url, so it cannot dodge the ignore match', () => {
    const { url: _, ...noUrl } = ESBUILD
    expect(() => parseAudit(JSON.stringify({ esbuild: [noUrl] }))).toThrow(AuditOutputError)
  })

  it('refuses a severity it does not know', () => {
    expect(() => parseAudit(JSON.stringify({ esbuild: [{ ...ESBUILD, severity: 'info' }] }))).toThrow(AuditOutputError)
  })
})

describe('classify', () => {
  it('suppresses an ignored advisory and reports nothing', () => {
    const c = classify(advisories({ esbuild: [ESBUILD] }), [IGNORE])
    expect(c).toMatchObject({ findings: [], stale: [] })
    expect(c.suppressed.map((a) => a.ghsa)).toEqual(['GHSA-g7r4-m6w7-qqqr'])
  })

  it('reports an ignore as stale once its advisory leaves the tree', () => {
    const c = classify([], [IGNORE])
    expect(c.stale).toEqual([IGNORE])
    expect(c.findings).toEqual([])
  })

  it('reports an ignored advisory again once it is re-rated, and keeps the ignore live', () => {
    const c = classify(advisories({ esbuild: [{ ...ESBUILD, severity: 'high' }] }), [IGNORE])
    expect(c.findings.map((a) => `${a.ghsa}:${a.severity}`)).toEqual(['GHSA-g7r4-m6w7-qqqr:high'])
    expect(c.stale).toEqual([])
  })

  it('reports the other advisories of an ignored package', () => {
    const c = classify(advisories({ esbuild: [ESBUILD, ESBUILD_OTHER] }), [IGNORE])
    expect(c.findings.map((a) => a.ghsa)).toEqual(['GHSA-aaaa-bbbb-cccc'])
  })
})

describe('marker', () => {
  it('does not depend on the order bun lists packages in', () => {
    const jsYaml = { ...ESBUILD, url: 'https://github.com/advisories/GHSA-2883-xcg3-v3hh', severity: 'high' }
    const a = marker(classify(advisories({ esbuild: [ESBUILD_OTHER], 'js-yaml': [jsYaml] }), []))
    const b = marker(classify(advisories({ 'js-yaml': [jsYaml], esbuild: [ESBUILD_OTHER] }), []))
    expect(a).toBe(b)
  })

  it('changes when a finding is re-rated', () => {
    const before = marker(classify(advisories({ esbuild: [ESBUILD_OTHER] }), []))
    const after = marker(classify(advisories({ esbuild: [{ ...ESBUILD_OTHER, severity: 'critical' }] }), []))
    expect(after).not.toBe(before)
  })
})
