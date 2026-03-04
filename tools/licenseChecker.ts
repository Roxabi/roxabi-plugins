#!/usr/bin/env bun

/**
 * License compliance checker for bun/Node.js projects.
 *
 * Scans installed packages via `license-checker`, checks licenses against
 * an allowlist, and reports violations.
 *
 * Usage:
 *   bun tools/licenseChecker.ts
 *   bun tools/licenseChecker.ts --json
 *   bun tools/licenseChecker.ts --policy .license-policy.json
 *   bun tools/licenseChecker.ts --output reports/licenses.json
 *
 * Exit code: 0 = compliant, 1 = violations found, 2 = tool error.
 *
 * Setup:
 *   bun add -d license-checker
 *
 * Policy file (.license-policy.json):
 *   {
 *     "allowlist": ["my-package"],
 *     "overrides": { "some-package": "MIT" }
 *   }
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// SPDX identifiers considered safe for commercial use.
const SAFE_LICENSES = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'CC0-1.0',
  'Unlicense',
  '0BSD',
  'BlueOak-1.0.0',
  'Python-2.0',
  'MPL-2.0',
  'LGPL-2.0',
  'LGPL-2.1',
  'LGPL-3.0',
])

interface PolicyFile {
  allowlist?: string[]
  overrides?: Record<string, string>
}

interface PackageEntry {
  name: string
  version: string
  license: string
}

interface Report {
  total: number
  compliant: number
  violations: number
  packages: PackageEntry[]
  violating: PackageEntry[]
}

function loadPolicy(policyPath: string): PolicyFile {
  if (existsSync(policyPath)) {
    try {
      return JSON.parse(readFileSync(policyPath, 'utf8')) as PolicyFile
    } catch (e) {
      console.error(`[license-check] Warning: could not parse ${policyPath}: ${e}`)
    }
  }
  return { allowlist: [], overrides: {} }
}

function getPackages(): Record<string, { licenses: string; version: string }> {
  try {
    const output = execSync('bunx license-checker --json --production', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return JSON.parse(output) as Record<string, { licenses: string; version: string }>
  } catch (_e) {
    console.error('[license-check] license-checker not available.\n  Install it: bun add -d license-checker')
    process.exit(2)
  }
}

function isCompliant(name: string, license: string, policy: PolicyFile): boolean {
  const overrides = policy.overrides ?? {}
  if (name in overrides) return true
  const allowlist = policy.allowlist ?? []
  if (allowlist.includes(name)) return true
  // Handle multiple licenses separated by OR/AND
  const parts = license.split(/\s*(?:OR|AND)\s*/i)
  return parts.some((l) => SAFE_LICENSES.has(l.trim().replace(/^\(|\)$/g, '')))
}

function parseArgs(): { policy: string; jsonOutput: boolean; output: string } {
  const args = process.argv.slice(2)
  let policy = '.license-policy.json'
  let jsonOutput = false
  let output = ''
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') jsonOutput = true
    if (args[i] === '--policy' && args[i + 1]) policy = args[++i]
    if (args[i] === '--output' && args[i + 1]) output = args[++i]
  }
  return { policy, jsonOutput, output }
}

const { policy: policyPath, jsonOutput, output } = parseArgs()
const policy = loadPolicy(policyPath)
const rawPackages = getPackages()

const compliant: PackageEntry[] = []
const violating: PackageEntry[] = []

for (const [nameAtVersion, info] of Object.entries(rawPackages)) {
  // license-checker uses "name@version" as keys
  const atIdx = nameAtVersion.lastIndexOf('@')
  const name = atIdx > 0 ? nameAtVersion.slice(0, atIdx) : nameAtVersion
  const version = info.version ?? (atIdx > 0 ? nameAtVersion.slice(atIdx + 1) : 'unknown')
  const license = info.licenses ?? 'UNKNOWN'
  const entry: PackageEntry = { name, version, license }
  if (isCompliant(name, license, policy)) {
    compliant.push(entry)
  } else {
    violating.push(entry)
  }
}

const total = compliant.length + violating.length
const report: Report = {
  total,
  compliant: compliant.length,
  violations: violating.length,
  packages: compliant,
  violating,
}

if (output) {
  const dir = dirname(output)
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(output, JSON.stringify(report, null, 2))
}

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`License check: ${total} packages scanned`)
  if (violating.length > 0) {
    console.log(`  ${violating.length} violation(s) found:`)
    for (const v of violating) {
      console.log(`     ${v.name} (${v.version}): ${v.license}`)
    }
    console.log()
    console.log('  Add to .license-policy.json to allow:')
    console.log(`  { "allowlist": [${violating.map((v) => `"${v.name}"`).join(', ')}] }`)
  } else {
    console.log(`  All ${compliant.length} packages are compliant`)
  }
}

process.exit(violating.length > 0 ? 1 : 0)
