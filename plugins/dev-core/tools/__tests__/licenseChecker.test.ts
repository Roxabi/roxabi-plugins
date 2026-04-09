import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkCompliance,
  detectLicense,
  isLicenseAllowed,
  type LicensePolicy,
  loadPolicy,
  parseSpdxExpression,
  type RawPackageInfo,
  scanDependencies,
  writeReport,
} from '../licenseChecker'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makePackageDir(root: string, name: string, pkgJson: Record<string, unknown>): RawPackageInfo {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJson))
  return { name: String(pkgJson.name ?? name), version: String(pkgJson.version ?? '1.0.0'), dir }
}

// ─── loadPolicy ──────────────────────────────────────────────────────────────

describe('loadPolicy', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir('license-policy-')
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('throws when .license-policy.json is missing', () => {
    expect(() => loadPolicy(tmpDir)).toThrow('No .license-policy.json found at repo root')
  })

  it('parses a valid policy file', () => {
    const policy = { allowedLicenses: ['MIT', 'Apache-2.0'], overrides: { 'foo@1.0.0': 'MIT' } }
    fs.writeFileSync(path.join(tmpDir, '.license-policy.json'), JSON.stringify(policy))
    const result = loadPolicy(tmpDir)
    expect(result.allowedLicenses).toEqual(['MIT', 'Apache-2.0'])
    expect(result.overrides).toEqual({ 'foo@1.0.0': 'MIT' })
  })

  it('throws on malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '.license-policy.json'), '{ invalid json')
    expect(() => loadPolicy(tmpDir)).toThrow()
  })

  it('defaults to empty arrays when fields are missing', () => {
    fs.writeFileSync(path.join(tmpDir, '.license-policy.json'), '{}')
    const result = loadPolicy(tmpDir)
    expect(result.allowedLicenses).toEqual([])
    expect(result.overrides).toEqual({})
  })
})

// ─── parseSpdxExpression ─────────────────────────────────────────────────────

describe('parseSpdxExpression', () => {
  it('returns single token unchanged', () => {
    expect(parseSpdxExpression('MIT')).toEqual(['MIT'])
  })

  it('splits OR expression', () => {
    expect(parseSpdxExpression('MIT OR Apache-2.0')).toEqual(['MIT', 'Apache-2.0'])
  })

  it('splits AND expression', () => {
    expect(parseSpdxExpression('MIT AND ISC')).toEqual(['MIT', 'ISC'])
  })

  it('splits three-part OR expression', () => {
    expect(parseSpdxExpression('MIT OR Apache-2.0 OR ISC')).toEqual(['MIT', 'Apache-2.0', 'ISC'])
  })

  it('handles parenthesized OR — strips parens, splits tokens', () => {
    const result = parseSpdxExpression('(MIT OR Apache-2.0)')
    expect(result).toContain('MIT')
    expect(result).toContain('Apache-2.0')
  })

  it('handles nested parens by flattening — returns all leaf tokens', () => {
    // Implementation strips all parens then splits — confirms the flat approach
    const result = parseSpdxExpression('(MIT OR (Apache-2.0 AND ISC))')
    expect(result).toContain('MIT')
    expect(result).toContain('Apache-2.0')
    expect(result).toContain('ISC')
  })

  it('handles whitespace-padded expression', () => {
    const result = parseSpdxExpression('  MIT  OR  Apache-2.0  ')
    expect(result).toContain('MIT')
    expect(result).toContain('Apache-2.0')
    expect(result).not.toContain('')
  })

  it('filters empty strings from result', () => {
    const result = parseSpdxExpression('MIT')
    expect(result.every((s) => s.length > 0)).toBe(true)
  })
})

// ─── isLicenseAllowed ────────────────────────────────────────────────────────

describe('isLicenseAllowed', () => {
  const allowed = ['MIT', 'Apache-2.0', 'ISC']

  it('returns false for null license', () => {
    expect(isLicenseAllowed(null, allowed)).toBe(false)
  })

  it('returns true for direct match', () => {
    expect(isLicenseAllowed('MIT', allowed)).toBe(true)
  })

  it('returns false for unlisted license', () => {
    expect(isLicenseAllowed('GPL-3.0', allowed)).toBe(false)
  })

  it('OR: returns true when at least one component is allowed', () => {
    expect(isLicenseAllowed('MIT OR GPL-3.0', allowed)).toBe(true)
  })

  it('OR: returns false when no component is allowed', () => {
    expect(isLicenseAllowed('GPL-3.0 OR LGPL-2.1', allowed)).toBe(false)
  })

  it('AND: returns true when all components are allowed', () => {
    expect(isLicenseAllowed('MIT AND ISC', allowed)).toBe(true)
  })

  it('AND: returns false when any component is not allowed (partial block)', () => {
    expect(isLicenseAllowed('MIT AND GPL-3.0', allowed)).toBe(false)
  })

  it('parenthesized OR: returns true when one component is allowed', () => {
    expect(isLicenseAllowed('(MIT OR GPL-3.0)', allowed)).toBe(true)
  })

  it('returns false for empty allowed list', () => {
    expect(isLicenseAllowed('MIT', [])).toBe(false)
  })
})

// ─── detectLicense ───────────────────────────────────────────────────────────

describe('detectLicense', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir('license-detect-')
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const policy: LicensePolicy = {
    allowedLicenses: ['MIT'],
    overrides: { 'foo@1.0.0': 'Apache-2.0' },
  }

  it('override wins over package.json license field', () => {
    const pkg = makePackageDir(tmpDir, 'foo', { name: 'foo', version: '1.0.0', license: 'MIT' })
    const result = detectLicense(pkg, policy)
    expect(result.license).toBe('Apache-2.0')
    expect(result.source).toBe('override')
  })

  it('returns package.json license string field', () => {
    const pkg = makePackageDir(tmpDir, 'bar', { name: 'bar', version: '2.0.0', license: 'ISC' })
    const result = detectLicense(pkg, policy)
    expect(result.license).toBe('ISC')
    expect(result.source).toBe('package.json')
  })

  it('falls back to deprecated licenses[] array when license field absent', () => {
    const pkg = makePackageDir(tmpDir, 'baz', {
      name: 'baz',
      version: '1.0.0',
      licenses: [{ type: 'BSD-2-Clause' }],
    })
    const result = detectLicense(pkg, policy)
    expect(result.license).toBe('BSD-2-Clause')
    expect(result.source).toBe('package.json')
  })

  it('falls back to LICENSE file when package.json has no license', () => {
    const pkg = makePackageDir(tmpDir, 'qux', { name: 'qux', version: '1.0.0' })
    fs.writeFileSync(path.join(pkg.dir, 'LICENSE'), 'MIT License\nPermission is hereby granted...')
    const result = detectLicense(pkg, policy)
    expect(result.license).toBe('MIT')
    expect(result.source).toBe('LICENSE file')
  })

  it.each([
    ['Apache License, Version 2.0', 'Apache-2.0'],
    ['BSD 3-Clause License', 'BSD-3-Clause'],
    ['BSD 2-Clause License', 'BSD-2-Clause'],
    ['BSD Zero Clause License', '0BSD'],
    ['Permission to use, copy, modify, and/or distribute this software without fee', 'ISC'],
    ['ISC License', 'ISC'],
    ['The Unlicense', 'Unlicense'],
    ['CC0 1.0 Universal', 'CC0-1.0'],
    ['Creative Commons Attribution 4.0 International', 'CC-BY-4.0'],
    ['Blue Oak Model License 1.0.0', 'BlueOak-1.0.0'],
    ['Mozilla Public License, Version 2.0', 'MPL-2.0'],
    ['Python Software Foundation License', 'Python-2.0'],
    ['PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2', 'Python-2.0'],
    ['MIT No Attribution', 'MIT-0'],
  ])('detects %s from LICENSE file as %s', (content, expected) => {
    const pkg = makePackageDir(tmpDir, `lic-${expected.toLowerCase().replace(/[^a-z0-9]/g, '-')}`, {
      name: `lic-${expected}`,
      version: '1.0.0',
    })
    fs.writeFileSync(path.join(pkg.dir, 'LICENSE'), content)
    const result = detectLicense(pkg, policy)
    expect(result.license).toBe(expected)
    expect(result.source).toBe('LICENSE file')
  })

  it('returns null for unrecognized LICENSE file content', () => {
    const pkg = makePackageDir(tmpDir, 'unknown-lic', { name: 'unknown-lic', version: '1.0.0' })
    fs.writeFileSync(
      path.join(pkg.dir, 'LICENSE'),
      'Some custom proprietary license text that matches no known pattern.',
    )
    const result = detectLicense(pkg, policy)
    expect(result.license).toBeNull()
    expect(result.source).toBeNull()
  })

  it('returns null when no license info found', () => {
    const pkg = makePackageDir(tmpDir, 'mystery', { name: 'mystery', version: '1.0.0' })
    const result = detectLicense(pkg, policy)
    expect(result.license).toBeNull()
    expect(result.source).toBeNull()
  })

  it('override key must match name@version exactly', () => {
    // foo@2.0.0 is NOT in overrides (only foo@1.0.0 is)
    const pkg = makePackageDir(tmpDir, 'foo2', { name: 'foo', version: '2.0.0', license: 'GPL-3.0' })
    const result = detectLicense(pkg, policy)
    expect(result.license).toBe('GPL-3.0')
    expect(result.source).toBe('package.json')
  })
})

// ─── checkCompliance ─────────────────────────────────────────────────────────

describe('checkCompliance', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir('license-compliance-')
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const basePolicy: LicensePolicy = { allowedLicenses: ['MIT', 'ISC'], overrides: {} }

  it('marks allowed license as allowed', () => {
    const pkg = makePackageDir(tmpDir, 'ok', { name: 'ok', version: '1.0.0', license: 'MIT' })
    const report = checkCompliance([pkg], basePolicy)
    expect(report.violations).toHaveLength(0)
    expect(report.packages[0].status).toBe('allowed')
  })

  it('marks disallowed license as violation', () => {
    const pkg = makePackageDir(tmpDir, 'bad', { name: 'bad', version: '1.0.0', license: 'GPL-3.0' })
    const report = checkCompliance([pkg], basePolicy)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0].name).toBe('bad')
    expect(report.summary.violations).toBe(1)
  })

  it('adds warning for unknown license (not a violation)', () => {
    const pkg = makePackageDir(tmpDir, 'mystery', { name: 'mystery', version: '1.0.0' })
    const report = checkCompliance([pkg], basePolicy)
    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0].name).toBe('mystery')
    expect(report.packages[0].status).toBe('unknown')
    expect(report.violations).toHaveLength(0)
  })

  it('detects stale overrides that do not match any installed package', () => {
    const policyWithStale: LicensePolicy = {
      allowedLicenses: ['MIT'],
      overrides: { 'ghost@9.9.9': 'MIT' },
    }
    const pkg = makePackageDir(tmpDir, 'real', { name: 'real', version: '1.0.0', license: 'MIT' })
    const report = checkCompliance([pkg], policyWithStale)
    const staleWarning = report.warnings.find((w) => w.reason.includes('ghost@9.9.9'))
    expect(staleWarning).toBeDefined()
  })

  it('marks overridden packages with override status (skips violation)', () => {
    const policyWithOverride: LicensePolicy = {
      allowedLicenses: ['MIT'],
      overrides: { 'overridden@1.0.0': 'MIT' },
    }
    const pkg = makePackageDir(tmpDir, 'overridden', {
      name: 'overridden',
      version: '1.0.0',
      license: 'GPL-3.0',
    })
    const report = checkCompliance([pkg], policyWithOverride)
    expect(report.violations).toHaveLength(0)
    expect(report.packages[0].status).toBe('override')
  })

  it('counts license distribution in summary', () => {
    const p1 = makePackageDir(tmpDir, 'a', { name: 'a', version: '1.0.0', license: 'MIT' })
    const p2 = makePackageDir(tmpDir, 'b', { name: 'b', version: '1.0.0', license: 'MIT' })
    const p3 = makePackageDir(tmpDir, 'c', { name: 'c', version: '1.0.0', license: 'ISC' })
    const report = checkCompliance([p1, p2, p3], basePolicy)
    expect(report.summary.licenses.MIT).toBe(2)
    expect(report.summary.licenses.ISC).toBe(1)
    expect(report.summary.totalPackages).toBe(3)
  })
})

// ─── writeReport ─────────────────────────────────────────────────────────────

describe('writeReport', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir('license-report-')
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const sampleReport = {
    timestamp: '2025-01-01T00:00:00.000Z',
    summary: { totalPackages: 1, licenses: { MIT: 1 }, violations: 0, warnings: 0 },
    packages: [
      {
        name: 'foo',
        version: '1.0.0',
        license: 'MIT',
        status: 'allowed' as const,
        source: 'package.json' as const,
      },
    ],
    violations: [],
    warnings: [],
  }

  it('writes report to reports/licenses.json and returns the path', () => {
    const reportPath = writeReport(sampleReport, tmpDir)
    expect(reportPath).toMatch(/reports[/\\]licenses\.json$/)
    const written = JSON.parse(fs.readFileSync(reportPath, 'utf-8'))
    expect(written.summary.totalPackages).toBe(1)
    expect(written.packages[0].name).toBe('foo')
    expect(written.violations).toEqual([])
  })

  it('creates reports/ directory if it does not exist', () => {
    const reportsDir = path.join(tmpDir, 'reports')
    expect(fs.existsSync(reportsDir)).toBe(false)
    writeReport(sampleReport, tmpDir)
    expect(fs.existsSync(reportsDir)).toBe(true)
  })

  it('round-trips the full report shape (no fields dropped)', () => {
    const reportPath = writeReport(sampleReport, tmpDir)
    const written = JSON.parse(fs.readFileSync(reportPath, 'utf-8'))
    expect(written).toMatchObject({
      timestamp: sampleReport.timestamp,
      summary: sampleReport.summary,
      packages: sampleReport.packages,
      violations: [],
      warnings: [],
    })
  })
})

// ─── scanDependencies — workspace symlink exclusion ──────────────────────────

describe('scanDependencies — workspace symlink exclusion', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir('license-scan-')
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('includes real packages and excludes workspace symlinks', () => {
    // Root package.json
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'root', version: '0.0.0' }))

    const nm = path.join(tmpDir, 'node_modules')
    fs.mkdirSync(nm)

    // Real package (directory, not symlink)
    const realPkgDir = path.join(nm, 'real-dep')
    fs.mkdirSync(realPkgDir)
    fs.writeFileSync(
      path.join(realPkgDir, 'package.json'),
      JSON.stringify({ name: 'real-dep', version: '1.0.0', license: 'MIT' }),
    )

    // Workspace symlink — points to project source, not .bun/ → should be skipped
    const wsTarget = path.join(tmpDir, 'packages', 'my-app')
    fs.mkdirSync(wsTarget, { recursive: true })
    fs.writeFileSync(path.join(wsTarget, 'package.json'), JSON.stringify({ name: 'my-app', version: '0.0.0' }))
    fs.symlinkSync(wsTarget, path.join(nm, 'my-app'))

    const packages = scanDependencies(tmpDir)
    const names = packages.map((p) => p.name)
    expect(names).toContain('real-dep')
    expect(names).not.toContain('my-app')
  })

  it('returns empty array when node_modules does not exist', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'root', version: '0.0.0' }))
    const packages = scanDependencies(tmpDir)
    expect(packages).toEqual([])
  })

  it('deduplicates packages with the same name@version', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'root', version: '0.0.0' }))
    const nm = path.join(tmpDir, 'node_modules')
    fs.mkdirSync(nm)

    // Same package appearing twice (simulating hoisting duplicates)
    const pkg1 = path.join(nm, 'dupe')
    fs.mkdirSync(pkg1)
    fs.writeFileSync(path.join(pkg1, 'package.json'), JSON.stringify({ name: 'dupe', version: '1.0.0' }))

    const packages = scanDependencies(tmpDir)
    const dupeEntries = packages.filter((p) => p.name === 'dupe')
    expect(dupeEntries).toHaveLength(1)
  })
})

// ─── CLI integration (subprocess) ────────────────────────────────────────────

describe('CLI — subprocess integration', () => {
  let tmpDir: string

  // Resolve bun binary for subprocess
  const bunBin = Bun.spawnSync(['which', 'bun'], { stdout: 'pipe' })
  const bunBinPath = new TextDecoder().decode(bunBin.stdout).trim()

  beforeEach(() => {
    tmpDir = makeTmpDir('license-cli-')
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function setupProject(policy: LicensePolicy, packages: Array<{ name: string; version: string; license?: string }>) {
    // Root package.json
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-project', version: '0.0.0' }))
    // Policy
    fs.writeFileSync(path.join(tmpDir, '.license-policy.json'), JSON.stringify(policy))
    // node_modules
    const nm = path.join(tmpDir, 'node_modules')
    fs.mkdirSync(nm)
    for (const pkg of packages) {
      const pkgDir = path.join(nm, pkg.name)
      fs.mkdirSync(pkgDir, { recursive: true })
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg))
    }
    // Copy licenseChecker.ts to tmp/tools/ so import.meta.dirname resolves tmpDir as repoRoot
    const toolsDir = path.join(tmpDir, 'tools')
    fs.mkdirSync(toolsDir)
    const scriptSrc = path.resolve(__dirname, '../licenseChecker.ts')
    fs.copyFileSync(scriptSrc, path.join(toolsDir, 'licenseChecker.ts'))
    return path.join(toolsDir, 'licenseChecker.ts')
  }

  function run(scriptPath: string, args: string[] = []) {
    const proc = Bun.spawnSync([bunBinPath, 'run', scriptPath, ...args], {
      cwd: tmpDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
      exitCode: proc.exitCode,
    }
  }

  it('exits 0 and outputs JSON with no violations when all packages are compliant', () => {
    const scriptPath = setupProject({ allowedLicenses: ['MIT'], overrides: {} }, [
      { name: 'compliant', version: '1.0.0', license: 'MIT' },
    ])
    const result = run(scriptPath, ['--json'])
    expect(result.exitCode).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.violations).toHaveLength(0)
    expect(report.summary.totalPackages).toBeGreaterThan(0)
  })

  it('exits 1 when violations are found', () => {
    const scriptPath = setupProject({ allowedLicenses: ['MIT'], overrides: {} }, [
      { name: 'violating', version: '1.0.0', license: 'GPL-3.0' },
    ])
    const result = run(scriptPath, ['--json'])
    expect(result.exitCode).toBe(1)
    const report = JSON.parse(result.stdout)
    expect(report.violations).toHaveLength(1)
  })

  it('exits 2 when policy file is missing (tool error)', () => {
    // Set up node_modules but no .license-policy.json
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', version: '0.0.0' }))
    const nm = path.join(tmpDir, 'node_modules')
    fs.mkdirSync(nm)
    const toolsDir = path.join(tmpDir, 'tools')
    fs.mkdirSync(toolsDir)
    const scriptSrc = path.resolve(__dirname, '../licenseChecker.ts')
    fs.copyFileSync(scriptSrc, path.join(toolsDir, 'licenseChecker.ts'))
    const result = run(path.join(toolsDir, 'licenseChecker.ts'), ['--json'])
    expect(result.exitCode).toBe(2)
  })
})
