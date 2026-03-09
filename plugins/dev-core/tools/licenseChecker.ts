/**
 * License Checker — Dependency License Compliance
 *
 * Scans all monorepo dependencies (direct and transitive) across workspace packages,
 * checks each license against a configurable allowlist, and produces a human-readable
 * CLI summary plus a machine-readable JSON report.
 *
 * Usage: bun run tools/licenseChecker.ts
 * Turbo: turbo run license:check
 *
 * Zero external dependencies — uses only Bun built-ins and Node.js fs/path.
 *
 * Copied into projects by /init Phase 10d via dev-core plugin.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LicensePolicy {
  allowedLicenses: string[]
  overrides: Record<string, string>
}

export interface PackageEntry {
  name: string
  version: string
  license: string | null
  status: 'allowed' | 'violation' | 'unknown' | 'override'
  source: 'package.json' | 'LICENSE file' | 'override' | null
}

export interface LicenseReport {
  timestamp: string
  summary: {
    totalPackages: number
    licenses: Record<string, number>
    violations: number
    warnings: number
  }
  packages: PackageEntry[]
  violations: PackageEntry[]
  warnings: Array<{ name: string; version: string; reason: string }>
}

// ─── Policy Loading ──────────────────────────────────────────────────────────

export function loadPolicy(repoRoot: string): LicensePolicy {
  const policyPath = join(repoRoot, '.license-policy.json')
  if (!existsSync(policyPath)) {
    throw new Error('No .license-policy.json found at repo root')
  }
  const raw = readFileSync(policyPath, 'utf-8')
  const policy = JSON.parse(raw) as LicensePolicy
  return {
    allowedLicenses: policy.allowedLicenses ?? [],
    overrides: policy.overrides ?? {},
  }
}

// ─── Node Modules Scanning ───────────────────────────────────────────────────

export interface RawPackageInfo {
  name: string
  version: string
  dir: string
}

const IGNORED_ENTRIES = new Set(['.cache', '.bin', '.package-lock.json'])

function collectBunPackages(nodeModulesDir: string): RawPackageInfo[] {
  const bunDir = join(nodeModulesDir, '.bun')
  const results: RawPackageInfo[] = []
  for (const bunEntry of readdirSync(bunDir)) {
    const innerNm = join(bunDir, bunEntry, 'node_modules')
    if (!existsSync(innerNm)) continue
    results.push(...listPackagesInNodeModules(innerNm))
  }
  return results
}

function collectScopedPackages(scopeDir: string): RawPackageInfo[] {
  if (!(existsSync(scopeDir) && lstatSync(scopeDir).isDirectory())) return []
  const results: RawPackageInfo[] = []
  for (const scoped of readdirSync(scopeDir)) {
    const info = readPackageInfo(join(scopeDir, scoped))
    if (info) results.push(info)
  }
  return results
}

function listPackagesInNodeModules(nodeModulesDir: string): RawPackageInfo[] {
  if (!existsSync(nodeModulesDir)) return []
  const results: RawPackageInfo[] = []

  for (const entry of readdirSync(nodeModulesDir)) {
    if (IGNORED_ENTRIES.has(entry)) continue

    if (entry === '.bun') {
      results.push(...collectBunPackages(nodeModulesDir))
      continue
    }

    if (entry.startsWith('@')) {
      results.push(...collectScopedPackages(join(nodeModulesDir, entry)))
      continue
    }

    const info = readPackageInfo(join(nodeModulesDir, entry))
    if (info) results.push(info)
  }
  return results
}

function isWorkspaceSymlink(pkgDir: string): boolean {
  try {
    const stat = lstatSync(pkgDir)
    if (!stat.isSymbolicLink()) return false
    // Bun symlinks point to .bun/ — those are real dependencies, not workspace links
    const target = readlinkSync(pkgDir)
    return !target.includes('.bun/')
  } catch {
    return false
  }
}

function readPackageInfo(pkgDir: string): RawPackageInfo | null {
  // Skip workspace symlinks (project code, not third-party)
  if (isWorkspaceSymlink(pkgDir)) return null

  // Resolve symlinks to get the real directory
  let realDir = pkgDir
  try {
    const stat = lstatSync(pkgDir)
    if (stat.isSymbolicLink()) {
      realDir = realpathSync(pkgDir)
    }
  } catch {
    return null
  }

  const pkgJsonPath = join(realDir, 'package.json')
  if (!existsSync(pkgJsonPath)) return null

  try {
    const raw = readFileSync(pkgJsonPath, 'utf-8')
    const pkg = JSON.parse(raw)
    if (!(pkg.name && pkg.version)) return null
    return { name: pkg.name, version: pkg.version, dir: realDir }
  } catch {
    return null
  }
}

function collectWorkspaceNodeModules(repoRoot: string): string[] {
  try {
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'))
    const workspaceGlobs: string[] = rootPkg.workspaces ?? []
    const workspaceDirs = new Set(workspaceGlobs.map((g: string) => g.replace(/\/\*$/, '')))
    const dirs: string[] = []
    for (const dir of workspaceDirs) {
      const wsRoot = join(repoRoot, dir)
      if (!existsSync(wsRoot)) continue
      for (const ws of readdirSync(wsRoot)) {
        const wsNodeModules = join(wsRoot, ws, 'node_modules')
        if (existsSync(wsNodeModules)) dirs.push(wsNodeModules)
      }
    }
    return dirs
  } catch {
    return []
  }
}

export function scanDependencies(repoRoot: string): RawPackageInfo[] {
  const seen = new Set<string>()
  const results: RawPackageInfo[] = []

  const nodeModulesDirs = [join(repoRoot, 'node_modules'), ...collectWorkspaceNodeModules(repoRoot)]

  for (const nmDir of nodeModulesDirs) {
    for (const pkg of listPackagesInNodeModules(nmDir)) {
      const key = `${pkg.name}@${pkg.version}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push(pkg)
    }
  }

  return results
}

// ─── License Detection ──────────────────────────────────────────────────────

const LICENSE_FILE_NAMES = ['LICENSE', 'LICENCE', 'LICENSE.md', 'LICENCE.md', 'LICENSE.txt', 'LICENCE.txt']

const LICENSE_PATTERNS: Array<[RegExp, string]> = [
  [/MIT License/i, 'MIT'],
  [/Permission is hereby granted, free of charge/i, 'MIT'],
  [/MIT No Attribution/i, 'MIT-0'],
  [/Apache License.*Version 2\.0/i, 'Apache-2.0'],
  [/BSD 3-Clause/i, 'BSD-3-Clause'],
  [/BSD 2-Clause/i, 'BSD-2-Clause'],
  [/BSD Zero Clause/i, '0BSD'],
  [/Permission to use, copy, modify, and\/or distribute.*without fee/i, 'ISC'],
  [/ISC License/i, 'ISC'],
  [/The Unlicense/i, 'Unlicense'],
  [/CC0 1\.0 Universal/i, 'CC0-1.0'],
  [/Creative Commons Attribution 4\.0/i, 'CC-BY-4.0'],
  [/Blue Oak Model License.*1\.0\.0/i, 'BlueOak-1.0.0'],
  [/Mozilla Public License.*Version 2\.0/i, 'MPL-2.0'],
  [/Python Software Foundation License/i, 'Python-2.0'],
  [/PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2/i, 'Python-2.0'],
]

function detectLicenseFromFile(pkgDir: string): string | null {
  for (const fileName of LICENSE_FILE_NAMES) {
    const filePath = join(pkgDir, fileName)
    if (!existsSync(filePath)) continue
    try {
      const content = readFileSync(filePath, 'utf-8').slice(0, 2000)
      for (const [pattern, license] of LICENSE_PATTERNS) {
        if (pattern.test(content)) return license
      }
    } catch {}
  }
  return null
}

export function detectLicense(
  pkg: RawPackageInfo,
  policy: LicensePolicy,
): { license: string | null; source: PackageEntry['source'] } {
  const key = `${pkg.name}@${pkg.version}`

  // 1. Override (highest priority)
  if (key in policy.overrides) {
    return { license: policy.overrides[key], source: 'override' }
  }

  // 2-3. package.json license field
  const pkgJsonPath = join(pkg.dir, 'package.json')
  try {
    const raw = readFileSync(pkgJsonPath, 'utf-8')
    const pkgJson = JSON.parse(raw)

    // 2. license field (string)
    if (typeof pkgJson.license === 'string' && pkgJson.license.trim()) {
      return { license: pkgJson.license.trim(), source: 'package.json' }
    }

    // 3. licenses array (deprecated)
    if (Array.isArray(pkgJson.licenses) && pkgJson.licenses.length > 0) {
      const first = pkgJson.licenses[0]
      const licenseStr = typeof first === 'string' ? first : first?.type
      if (licenseStr) return { license: licenseStr, source: 'package.json' }
    }
  } catch {
    // Fall through to file detection
  }

  // 4. LICENSE file
  const fileLicense = detectLicenseFromFile(pkg.dir)
  if (fileLicense) return { license: fileLicense, source: 'LICENSE file' }

  // 5. Unknown
  return { license: null, source: null }
}

// ─── SPDX Expression Handling ────────────────────────────────────────────────

export function parseSpdxExpression(expression: string): string[] {
  // Strip all parens and split on OR/AND
  const cleaned = expression.replace(/[()]/g, '')
  return cleaned
    .split(/\s+(?:OR|AND)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function isLicenseAllowed(license: string | null, allowedLicenses: string[]): boolean {
  if (!license) return false

  // Direct match
  if (allowedLicenses.includes(license)) return true

  // SPDX AND expression — all components must be allowed (check before OR/parens)
  if (license.includes(' AND ')) {
    const components = parseSpdxExpression(license)
    return components.every((c) => allowedLicenses.includes(c))
  }

  // SPDX OR expression — at least one component must be allowed
  if (license.includes(' OR ') || license.startsWith('(')) {
    const components = parseSpdxExpression(license)
    return components.some((c) => allowedLicenses.includes(c))
  }

  return false
}

// ─── Compliance Check ────────────────────────────────────────────────────────

export function checkCompliance(packages: RawPackageInfo[], policy: LicensePolicy): LicenseReport {
  const entries: PackageEntry[] = []
  const violations: PackageEntry[] = []
  const warnings: LicenseReport['warnings'] = []
  const licenseCounts: Record<string, number> = {}

  for (const pkg of packages) {
    const { license, source } = detectLicense(pkg, policy)

    let status: PackageEntry['status']
    if (source === 'override') {
      status = 'override'
    } else if (license === null) {
      status = 'unknown'
      warnings.push({
        name: pkg.name,
        version: pkg.version,
        reason: 'No license field or LICENSE file found',
      })
    } else if (isLicenseAllowed(license, policy.allowedLicenses)) {
      status = 'allowed'
    } else {
      status = 'violation'
    }

    const entry: PackageEntry = {
      name: pkg.name,
      version: pkg.version,
      license,
      status,
      source,
    }

    entries.push(entry)
    if (status === 'violation') violations.push(entry)
    if (license) {
      licenseCounts[license] = (licenseCounts[license] ?? 0) + 1
    }
  }

  // Detect stale overrides that don't match any scanned package
  const scannedKeys = new Set(packages.map((p) => `${p.name}@${p.version}`))
  for (const overrideKey of Object.keys(policy.overrides)) {
    if (!scannedKeys.has(overrideKey)) {
      warnings.push({
        name: overrideKey.replace(/@[^@]+$/, ''),
        version: overrideKey.replace(/^.*@/, ''),
        reason: `Override "${overrideKey}" does not match any installed package`,
      })
    }
  }

  return {
    timestamp: new Date().toISOString(),
    summary: {
      totalPackages: entries.length,
      licenses: licenseCounts,
      violations: violations.length,
      warnings: warnings.length,
    },
    packages: entries,
    violations,
    warnings,
  }
}

// ─── Report Generation ──────────────────────────────────────────────────────

export function writeReport(report: LicenseReport, repoRoot: string): string {
  const reportsDir = join(repoRoot, 'reports')
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true })
  }
  const reportPath = join(reportsDir, 'licenses.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  return reportPath
}

// ─── CLI Output ──────────────────────────────────────────────────────────────

function printLicenseDistribution(licenses: Record<string, number>): void {
  const sorted = Object.entries(licenses).sort((a, b) => b[1] - a[1])
  if (sorted.length === 0) return
  console.log('Licenses found:')
  const maxNameLen = Math.max(...sorted.map(([name]) => name.length))
  for (const [name, count] of sorted) {
    console.log(`  ${name.padEnd(maxNameLen + 2)}${count}`)
  }
  console.log()
}

function printViolations(violations: PackageEntry[]): void {
  if (violations.length === 0) return
  const s = violations.length > 1 ? 's' : ''
  console.log(`\u274c ${violations.length} violation${s}:`)
  for (const v of violations) {
    console.log(`  ${v.name}@${v.version}    ${v.license}`)
  }
  console.log()
}

function printWarnings(warnings: LicenseReport['warnings']): void {
  if (warnings.length === 0) return
  const s = warnings.length > 1 ? 's' : ''
  console.log(`\u26a0  ${warnings.length} package${s} with unknown license (see report)`)
  for (const w of warnings) {
    console.log(`  ${w.name}@${w.version}    UNKNOWN`)
  }
  console.log()
}

export function printSummary(report: LicenseReport, reportPath: string): void {
  console.log(`\nLicense Check — ${report.summary.totalPackages} packages scanned\n`)
  printLicenseDistribution(report.summary.licenses)
  printViolations(report.violations)
  printWarnings(report.warnings)
  if (report.violations.length === 0) {
    console.log('\u2705 No violations found')
  }
  console.log(`\nReport written to ${reportPath}`)
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const jsonMode = process.argv.includes('--json')

  try {
    const repoRoot = resolve(import.meta.dirname ?? '.', '..')

    // 1. Validate node_modules exists
    if (!existsSync(join(repoRoot, 'node_modules'))) {
      if (!jsonMode) console.error('Error: Run `bun install` first')
      process.exit(1)
    }

    // 2. Load policy
    const policy = loadPolicy(repoRoot)

    // 3-5. Scan dependencies and check compliance
    const packages = scanDependencies(repoRoot)
    const report = checkCompliance(packages, policy)

    if (jsonMode) {
      // Machine-readable output: emit JSON, suppress human output
      process.stdout.write(JSON.stringify(report))
    } else {
      // 6. Generate report
      const reportPath = writeReport(report, repoRoot)

      // 7. Print CLI output
      printSummary(report, reportPath)
    }

    // 8. Exit with appropriate code
    process.exit(report.summary.violations > 0 ? 1 : 0)
  } catch (error) {
    if (!jsonMode) console.error(`Error: ${error instanceof Error ? error.message : error}`)
    process.exit(2)
  }
}

// Only run when executed directly, not when imported for testing
if (import.meta.main) {
  main()
}
