#!/usr/bin/env bun
/**
 * Review roster oracle: (Δ, τ, σ, stack) → spawn set.
 * path_hit / priced-fence parsing provenance: #419.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const VALID_CLAIMS = new Set(['fail-closed', 'authz', 'ssot'])

export type ReviewTier = 'S' | 'F-lite' | 'F-full'
export type OracleOk = 'true' | 'false' | 'missing'
export type AgentOverride = 'default' | 'always' | 'never'

export type StackPaths = {
  frontendPath: string
  sharedUi: string
  backendPath: string
}

export type RosterConfig = {
  maxAgents: number
  verifyBelowConfidence: number
  recallMinDelta: number
  overrides: Record<string, AgentOverride>
  warnings: string[]
}

export type GateRow = {
  agent: string
  spawn: boolean
  reason: string
}

export type RosterResult = {
  tier: ReviewTier
  delta_count: number
  chunks: number
  agents: string[]
  gates: GateRow[]
  capped: string[]
  path_hit: boolean
  spawn_security_auditor: boolean
  delta_test_hit: boolean
  claims: string[]
  priced_claim_ok: boolean
  recall_eligible: boolean
  recall_reason: string
  verifier_enabled: boolean
  verify_below_confidence: number
  max_agents: number
  warnings: string[]
  review_halt: boolean
}

export type ComputeRosterInput = {
  delta: string[]
  tier: ReviewTier
  chunks: number
  oracleOk: OracleOk
  claims: string[]
  pricedClaimOk: boolean
  specDraft: boolean
  axialAdr: boolean
  stackPaths: StackPaths
  config: RosterConfig
}

type Gate = { spawn: boolean; reason: string }

export const DISPATCHABLE = [
  'adversarial',
  'security-auditor',
  'tester',
  'axial-adr-review',
  'frontend-dev',
  'backend-dev',
  'devops',
  'architect',
] as const

export const PHASE_AGENTS = ['recall', 'finding-verifier'] as const

const KNOWN_AGENTS: Record<string, true> = Object.fromEntries([...DISPATCHABLE, ...PHASE_AGENTS].map((a) => [a, true]))

const OVERRIDE_VALUES: Record<string, true> = { default: true, always: true, never: true }

const TEST_DIR_RE = /(^|\/)(__tests__|tests?)\//
const TEST_EXT_RE = /\.(test|spec)\.[cm]?[jt]sx?$/
const TEST_PY_RE = /(^|\/)test_[^/]+\.py$/
const TEST_SUFFIX_RE = /_test\.(py|go|rs)$/
const FE_EXT_RE = /\.(tsx|jsx|vue|svelte|css|scss)$/
const AXIAL_RE = /^(infrastructure|adapters|domains|stages)\//
const INFRA_RES = [
  /(^|\/)scripts\//,
  /(^|\/)\.github\//,
  /(^|\/)lefthook\.ya?ml$/,
  /(^|\/)wrangler\.(toml|jsonc?|json)$/,
  /(^|\/)deploy\//,
  /(^|\/)deploy\.sh$/,
  /(^|\/)Dockerfile$/,
  /(^|\/)docker-compose\.ya?ml$/,
  /(^|\/)Makefile$/,
  /(^|\/)Justfile$/,
  /\.tf$/,
  /(^|\/)k8s\//,
  /(^|\/)helm\//,
  /(^|\/)terraform\//,
  /(^|\/)\.gitlab-ci\.yml$/,
  /(^|\/)\.circleci\//,
]

/** Security path vocabulary — exact token match (¬substring: `author` must not hit `auth`). */
const TOKEN_SET: Record<string, true> = {
  auth: true,
  authn: true,
  authz: true,
  oauth: true,
  oidc: true,
  saml: true,
  sso: true,
  mfa: true,
  otp: true,
  session: true,
  sessions: true,
  jwt: true,
  login: true,
  signin: true,
  signup: true,
  logout: true,
  token: true,
  tokens: true,
  secret: true,
  secrets: true,
  crypto: true,
  credential: true,
  credentials: true,
  password: true,
  passwd: true,
  cert: true,
  certs: true,
  tls: true,
  ssl: true,
  rbac: true,
  permission: true,
  permissions: true,
  acl: true,
  iam: true,
  hmac: true,
  keystore: true,
}

const STEM_SET = ['secret', 'crypto', 'password', 'passwd', 'credential', 'keystore']

const DEFAULT_MAX_AGENTS = 4
const DEFAULT_VERIFY = 90
const DEFAULT_RECALL_MIN = 50

export function extractYamlBlocks(content: string): string[] {
  const blocks: string[] = []
  const re = /```ya?ml[^\n]*\n([\s\S]*?)```/gi
  let m = re.exec(content)
  while (m) {
    blocks.push(m[1].replace(/\r\n/g, '\n'))
    m = re.exec(content)
  }
  return blocks
}

export function parseClaimTags(yaml: string): string[] | null {
  const lines = yaml.split('\n')
  for (const line of lines) {
    const m = line.match(/^\s*claim:\s*(.*)$/)
    if (!m) continue
    const raw = m[1].trim()
    if (!raw) return null
    if (raw.startsWith('[')) {
      const inner = raw.slice(1, raw.endsWith(']') ? -1 : undefined)
      const tags = inner
        .split(',')
        .map((t) =>
          t
            .trim()
            .replace(/^['"]|['"]$/g, '')
            .toLowerCase(),
        )
        .filter(Boolean)
      return tags.length ? tags : null
    }
    return [raw.replace(/^['"]|['"]$/g, '').toLowerCase()]
  }
  return null
}

export function validateClaimTags(tags: string[] | null): tags is string[] {
  if (!tags?.length) return false
  return tags.every((t) => VALID_CLAIMS.has(t))
}

export function parsePricedFences(specContent: string): {
  claims: string[]
  pricedClaimOk: boolean
  hasPricedFence: boolean
} {
  const allClaims = new Set<string>()
  let hasPricedFence = false
  let pricedClaimOk = true

  for (const block of extractYamlBlocks(specContent)) {
    if (!/^\s*priced:/m.test(block)) continue
    hasPricedFence = true
    if (!/^\s*not:/m.test(block) || !/^\s*oracles:/m.test(block)) {
      pricedClaimOk = false
      continue
    }
    const tags = parseClaimTags(block)
    if (!validateClaimTags(tags)) {
      pricedClaimOk = false
      continue
    }
    for (const t of tags) allClaims.add(t)
  }

  return { claims: [...allClaims], pricedClaimOk, hasPricedFence }
}

export function specIsDraft(specContent: string): boolean {
  const fm = specContent.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return false
  const status = fm[1]
    .match(/^status:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, '')
  return status === 'draft'
}

/** path_hit := ∃ t ∈ tokens(path): t ∈ TOKEN_SET  ∨  ∃ s ∈ STEM_SET: s ⊂ lowercase(path) */
export function pathHit(delta: string[]): boolean {
  for (const f of delta) {
    const lower = f.toLowerCase()
    const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean)
    if (tokens.some((t) => Object.hasOwn(TOKEN_SET, t))) return true
    if (STEM_SET.some((s) => lower.includes(s))) return true
  }
  return false
}

export function testHit(delta: string[]): boolean {
  return delta.some((f) => TEST_DIR_RE.test(f) || TEST_EXT_RE.test(f) || TEST_PY_RE.test(f) || TEST_SUFFIX_RE.test(f))
}

export function infraHit(delta: string[]): boolean {
  return delta.some((f) => INFRA_RES.some((re) => re.test(f)))
}

export function axialDeltaHit(delta: string[]): boolean {
  return delta.some((f) => AXIAL_RE.test(f))
}

function prefixHit(delta: string[], prefix: string): boolean {
  const p = prefix.replace(/\/+$/, '')
  if (!p) return false
  return delta.some((f) => f === p || f.startsWith(`${p}/`))
}

export function feHit(delta: string[], paths: { frontendPath: string; sharedUi: string }): boolean {
  const prefixes = [paths.frontendPath, paths.sharedUi].map((s) => s.replace(/\/+$/, '')).filter(Boolean)
  if (prefixes.length) return prefixes.some((p) => prefixHit(delta, p))
  return delta.some((f) => FE_EXT_RE.test(f))
}

export function hasAxialAdr(adrDir: string, warnings?: string[]): boolean {
  try {
    const entries = readdirSync(adrDir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      const text = readFileSync(join(adrDir, e.name), 'utf-8')
      if (/^axial:\s*true/m.test(text)) return true
    }
    return false
  } catch (err) {
    let code = ''
    if (typeof err === 'object' && err !== null && 'code' in err) {
      const raw = err.code
      if (typeof raw === 'string') code = raw
    }
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    const message = err instanceof Error ? err.message : String(err)
    warnings?.push(`axial ADR dir unreadable: ${message}`)
    return false
  }
}

function stripInlineComment(line: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      out += c
      if (c === quote && line[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out += c
      continue
    }
    if (c === '#') break
    out += c
  }
  return out.trimEnd()
}

function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

function lineIndent(line: string): number {
  const m = line.match(/^[ ]*/)
  return m ? m[0].length : 0
}

type YamlLine = { indent: number; key: string; value: string }

function parseYamlLines(text: string): YamlLine[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\t/g, '  ')
  const rows: YamlLine[] = []
  for (const raw of normalized.split('\n')) {
    const stripped = stripInlineComment(raw)
    if (!stripped.trim()) continue
    const indent = lineIndent(stripped)
    const content = stripped.trim()
    const colon = content.indexOf(':')
    if (colon < 0) continue
    const key = content.slice(0, colon).trim()
    const value = unquote(content.slice(colon + 1))
    if (!key) continue
    rows.push({ indent, key, value })
  }
  return rows
}

function blockEnd(lines: YamlLine[], startIdx: number): number {
  const base = lines[startIdx].indent
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].indent <= base) return i
  }
  return lines.length
}

function parseInteger(raw: string, fallback: number, name: string, warnings: string[]): number {
  if (!raw) return fallback
  if (!/^-?\d+$/.test(raw)) {
    warnings.push(`${name} is not an integer; using default ${fallback}`)
    return fallback
  }
  return Number(raw)
}

export function parseRosterConfig(text: string | null): RosterConfig {
  const defaults: RosterConfig = {
    maxAgents: DEFAULT_MAX_AGENTS,
    verifyBelowConfidence: DEFAULT_VERIFY,
    recallMinDelta: DEFAULT_RECALL_MIN,
    overrides: Object.create(null),
    warnings: [],
  }
  if (text == null || !text.trim()) return defaults

  try {
    const lines = parseYamlLines(text)
    const reviewIdxs: number[] = []
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indent === 0 && lines[i].key === 'review') reviewIdxs.push(i)
    }
    if (!reviewIdxs.length) return defaults
    const warnings: string[] = []
    if (reviewIdxs.length > 1) warnings.push('duplicate top-level review: block ignored')
    const reviewIdx = reviewIdxs[0]
    const reviewEnd = blockEnd(lines, reviewIdx)
    let rosterIdx = -1
    for (let i = reviewIdx + 1; i < reviewEnd; i++) {
      if (lines[i].key === 'roster' && lines[i].indent > lines[reviewIdx].indent) {
        rosterIdx = i
        break
      }
    }
    if (rosterIdx < 0) {
      return { ...defaults, warnings }
    }

    let maxAgents = DEFAULT_MAX_AGENTS
    let verifyBelowConfidence = DEFAULT_VERIFY
    let recallMinDelta = DEFAULT_RECALL_MIN
    // Null-prototype: keys come from stack.yml, so `overrides.constructor` must be undefined.
    const overrides: Record<string, AgentOverride> = Object.create(null)

    const rosterIndent = lines[rosterIdx].indent
    const rosterEnd = blockEnd(lines, rosterIdx)
    const children = lines.slice(rosterIdx + 1, rosterEnd).filter((l) => l.indent > rosterIndent)
    if (!children.length) {
      return { maxAgents, verifyBelowConfidence, recallMinDelta, overrides, warnings }
    }
    const directIndent = Math.min(...children.map((l) => l.indent))

    for (let i = rosterIdx + 1; i < rosterEnd; i++) {
      const line = lines[i]
      if (line.indent !== directIndent) continue
      if (line.key === 'max_agents') {
        maxAgents = parseInteger(line.value, DEFAULT_MAX_AGENTS, 'max_agents', warnings)
        if (maxAgents < 1) {
          warnings.push('max_agents < 1; clamped to 1')
          maxAgents = 1
        }
      } else if (line.key === 'verify_below_confidence') {
        verifyBelowConfidence = parseInteger(line.value, DEFAULT_VERIFY, 'verify_below_confidence', warnings)
        if (verifyBelowConfidence > 90) {
          warnings.push('verify_below_confidence > 90; clamped to 90')
          verifyBelowConfidence = 90
        } else if (verifyBelowConfidence < 0) {
          warnings.push('verify_below_confidence < 0; clamped to 0')
          verifyBelowConfidence = 0
        }
      } else if (line.key === 'recall_min_delta') {
        recallMinDelta = parseInteger(line.value, DEFAULT_RECALL_MIN, 'recall_min_delta', warnings)
      } else if (line.key === 'agents') {
        const agentsEnd = blockEnd(lines, i)
        let recognised = 0
        for (let j = i + 1; j < agentsEnd; j++) {
          if (lines[j].indent <= line.indent) break
          recognised++
          const agent = lines[j].key
          const raw = lines[j].value.toLowerCase()
          if (agent === 'product-lead') {
            warnings.push('product-lead is not part of the review roster — Phase 2 covers spec compliance')
            continue
          }
          if (!Object.hasOwn(KNOWN_AGENTS, agent)) {
            warnings.push(`unknown roster agent: ${agent}`)
            continue
          }
          if (!Object.hasOwn(OVERRIDE_VALUES, raw)) {
            warnings.push(`invalid override for ${agent}: ${lines[j].value}; using default`)
            continue
          }
          overrides[agent] = raw as AgentOverride
        }
        if (recognised === 0) {
          warnings.push('roster agents block present but no key: value entries recognised (sequence or flow mapping?)')
        }
      } else {
        warnings.push(`unknown roster key: ${line.key}`)
      }
    }

    return { maxAgents, verifyBelowConfidence, recallMinDelta, overrides, warnings }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ...defaults,
      warnings: [`review.roster parse failed: ${message}; using defaults`],
    }
  }
}

export function parseStackPaths(text: string | null): StackPaths {
  if (text == null || !text.trim()) {
    return { frontendPath: '', sharedUi: '', backendPath: '' }
  }
  const lines = parseYamlLines(text)
  const childScalar = (blockKey: string, childKey: string): string => {
    const idx = lines.findIndex((l) => l.indent === 0 && l.key === blockKey)
    if (idx < 0) return ''
    const end = blockEnd(lines, idx)
    for (let i = idx + 1; i < end; i++) {
      if (lines[i].indent > 0 && lines[i].key === childKey) return lines[i].value
    }
    return ''
  }
  return {
    frontendPath: childScalar('frontend', 'path'),
    sharedUi: childScalar('shared', 'ui'),
    backendPath: childScalar('backend', 'path'),
  }
}

function applyOverride(agent: string, gate: Gate, overrides: Record<string, AgentOverride>, warnings: string[]): Gate {
  // `overrides` may be a caller-built literal (prototype-exposed), so read own keys only —
  // an inherited `constructor`/`toString` must never resolve as an override.
  const o = Object.hasOwn(overrides, agent) ? overrides[agent] : undefined
  if (agent === 'adversarial') {
    if (o === 'never') warnings.push('adversarial cannot be disabled')
    return { spawn: true, reason: 'floor' }
  }
  if (o === 'always') return { spawn: true, reason: 'stack:always' }
  if (o === 'never') return { spawn: false, reason: 'stack:never' }
  return gate
}

function testerGate(deltaTestHit: boolean, oracleOk: OracleOk, warnings: string[]): Gate {
  if (!deltaTestHit) return { spawn: false, reason: 'no-test-delta' }
  if (oracleOk === 'missing') {
    warnings.push('tester gate undecided: re-run roster.sh with --oracle-ok')
    return { spawn: false, reason: 'oracle-unknown' }
  }
  if (oracleOk === 'true') return { spawn: false, reason: 'oracle-ok' }
  return { spawn: true, reason: 'oracle-false' }
}

function axialGate(axialAdr: boolean, delta: string[]): Gate {
  if (!axialAdr) return { spawn: false, reason: 'no-axial-adr' }
  if (!axialDeltaHit(delta)) return { spawn: false, reason: 'no-path-hit' }
  return { spawn: true, reason: 'path-hit' }
}

function backendGate(delta: string[], backendPath: string): Gate {
  if (!backendPath.replace(/\/+$/, '')) return { spawn: false, reason: 'no-backend-path' }
  if (prefixHit(delta, backendPath)) return { spawn: true, reason: 'path-hit' }
  return { spawn: false, reason: 'no-path-hit' }
}

function devopsGate(isFull: boolean, infra: boolean): Gate {
  if (!isFull) return { spawn: false, reason: 'tier' }
  if (infra) return { spawn: true, reason: 'infra' }
  return { spawn: false, reason: 'no-path-hit' }
}

function architectGate(isFull: boolean, infra: boolean): Gate {
  if (!isFull) return { spawn: false, reason: 'tier' }
  if (infra) return { spawn: false, reason: 'infra' }
  return { spawn: true, reason: 'structure' }
}

function recallGate(chunks: number, deltaCount: number, minDelta: number): Gate {
  if (chunks <= 1) return { spawn: false, reason: 'single-chunk' }
  if (deltaCount <= minDelta) return { spawn: false, reason: 'delta-below-min' }
  return { spawn: true, reason: 'multi-chunk' }
}

export function computeRoster(input: ComputeRosterInput): RosterResult {
  const { delta, tier, chunks, oracleOk, pricedClaimOk, axialAdr, stackPaths, config } = input
  const warnings = [...config.warnings]
  const claims = input.specDraft ? [] : input.claims.filter((c) => VALID_CLAIMS.has(c))
  const path_hit = pathHit(delta)
  const delta_test_hit = testHit(delta)
  const infra = infraHit(delta)
  const isFull = tier === 'F-full'

  const gates: Record<string, Gate> = {}

  gates.adversarial = applyOverride('adversarial', { spawn: true, reason: 'floor' }, config.overrides, warnings)

  gates['security-auditor'] = applyOverride(
    'security-auditor',
    { spawn: path_hit, reason: path_hit ? 'path-hit' : 'no-path-hit' },
    config.overrides,
    warnings,
  )

  gates.tester = applyOverride('tester', testerGate(delta_test_hit, oracleOk, warnings), config.overrides, warnings)

  gates['axial-adr-review'] = applyOverride('axial-adr-review', axialGate(axialAdr, delta), config.overrides, warnings)

  const feSpawn = feHit(delta, stackPaths)
  gates['frontend-dev'] = applyOverride(
    'frontend-dev',
    { spawn: feSpawn, reason: feSpawn ? 'path-hit' : 'no-path-hit' },
    config.overrides,
    warnings,
  )

  gates['backend-dev'] = applyOverride(
    'backend-dev',
    backendGate(delta, stackPaths.backendPath),
    config.overrides,
    warnings,
  )

  gates.devops = applyOverride('devops', devopsGate(isFull, infra), config.overrides, warnings)

  gates.architect = applyOverride('architect', architectGate(isFull, infra), config.overrides, warnings)

  gates.recall = applyOverride(
    'recall',
    recallGate(chunks, delta.length, config.recallMinDelta),
    config.overrides,
    warnings,
  )

  const verifierSpawn = config.verifyBelowConfidence > 0
  gates['finding-verifier'] = applyOverride(
    'finding-verifier',
    { spawn: verifierSpawn, reason: verifierSpawn ? 'threshold' : 'disabled' },
    config.overrides,
    warnings,
  )

  const spawned = DISPATCHABLE.filter((a) => gates[a].spawn)
  let maxAgents = config.maxAgents
  const forced = spawned.filter((a) => {
    const r = gates[a].reason
    return r === 'floor' || r === 'stack:always'
  })
  const gated = spawned.filter((a) => {
    const r = gates[a].reason
    return r !== 'floor' && r !== 'stack:always'
  })
  if (forced.length > maxAgents) {
    warnings.push(`max_agents (${maxAgents}) < forced agents (${forced.length}) — cap raised to ${forced.length}`)
    maxAgents = forced.length
  }
  const room = maxAgents - forced.length
  const keptGated = gated.slice(0, room)
  const capped = gated.slice(room)
  const kept = [...forced, ...keptGated]
  for (const a of capped) {
    gates[a] = { spawn: false, reason: 'capped' }
  }
  if (capped.length) {
    warnings.push(`roster: ${capped.length} agent(s) dropped by max_agents: ${capped.join(', ')}`)
  }

  const gateRows: GateRow[] = [...DISPATCHABLE, ...PHASE_AGENTS].map((agent) => ({
    agent,
    spawn: gates[agent].spawn,
    reason: gates[agent].reason,
  }))

  return {
    tier,
    delta_count: delta.length,
    chunks,
    agents: [...kept],
    gates: gateRows,
    capped,
    path_hit,
    spawn_security_auditor: gates['security-auditor'].spawn,
    delta_test_hit,
    claims,
    priced_claim_ok: pricedClaimOk,
    recall_eligible: gates.recall.spawn,
    recall_reason: gates.recall.reason,
    verifier_enabled: gates['finding-verifier'].spawn,
    verify_below_confidence: config.verifyBelowConfidence,
    max_agents: maxAgents,
    warnings,
    review_halt: false,
  }
}

function usage(): never {
  console.error(
    'usage: roster.ts --diff-list FILE [--tier S|F-lite|F-full] [--spec PATH] [--oracle-ok true|false|missing] [--chunks N] [--stack PATH] [--adr-dir PATH] [--json]',
  )
  process.exit(1)
}

const TIERS: Record<string, true> = { S: true, 'F-lite': true, 'F-full': true }
const ORACLE_OK: Record<string, true> = { true: true, false: true, missing: true }

function printResult(result: RosterResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  for (const [k, v] of Object.entries(result)) {
    if (Array.isArray(v) || (typeof v === 'object' && v !== null)) console.log(`${k}=${JSON.stringify(v)}`)
    else console.log(`${k}=${v}`)
  }
}

function main(): void {
  const args = process.argv.slice(2)
  let diffList = ''
  let tier: ReviewTier = 'F-lite'
  let specPath: string | null = null
  let oracleOk: OracleOk = 'missing'
  let chunks = 1
  let stackPath = '.claude/stack.yml'
  let adrDir = 'docs/architecture/adr'
  let json = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const next = args[i + 1]
    if (a === '--diff-list' && next !== undefined) {
      diffList = next
      i++
    } else if (a === '--tier' && next !== undefined) {
      if (!Object.hasOwn(TIERS, next)) usage()
      tier = next as ReviewTier
      i++
    } else if (a === '--spec' && next !== undefined) {
      specPath = next
      i++
    } else if (a === '--oracle-ok' && next !== undefined) {
      if (!Object.hasOwn(ORACLE_OK, next)) usage()
      oracleOk = next as OracleOk
      i++
    } else if (a === '--chunks' && next !== undefined) {
      if (!/^[1-9]\d*$/.test(next)) usage()
      chunks = Number(next)
      i++
    } else if (a === '--stack' && next !== undefined) {
      stackPath = next
      i++
    } else if (a === '--adr-dir' && next !== undefined) {
      adrDir = next
      i++
    } else if (a === '--json') {
      json = true
    } else {
      usage()
    }
  }

  if (!diffList) usage()

  let delta: string[]
  try {
    delta = readFileSync(diffList, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    console.error('roster: unreadable --diff-list')
    process.exit(1)
  }

  let stackText: string | null = null
  try {
    stackText = readFileSync(stackPath, 'utf-8')
  } catch {
    stackText = null
  }

  let specContent: string | null = null
  let specUnreadable = false
  if (specPath) {
    try {
      specContent = readFileSync(specPath, 'utf-8')
    } catch {
      specUnreadable = true
    }
  }

  let claims: string[] = []
  let pricedClaimOk = true
  let hasPricedFence = false
  let specDraft = false
  if (specContent != null) {
    const parsed = parsePricedFences(specContent)
    claims = parsed.claims
    pricedClaimOk = parsed.pricedClaimOk
    hasPricedFence = parsed.hasPricedFence
    specDraft = specIsDraft(specContent)
  }

  const config = parseRosterConfig(stackText)
  const result = computeRoster({
    delta,
    tier,
    chunks,
    oracleOk,
    claims,
    pricedClaimOk,
    specDraft,
    axialAdr: hasAxialAdr(adrDir, config.warnings),
    stackPaths: parseStackPaths(stackText),
    config,
  })

  if (specUnreadable) {
    result.review_halt = true
    result.warnings.push(`unreadable spec: ${specPath}`)
  }

  printResult(result, json)

  if (specUnreadable) {
    console.error(`roster: unreadable spec: ${specPath}`)
    process.exit(1)
  }
  if (hasPricedFence && !result.priced_claim_ok) {
    console.error('roster: priced fence missing a valid claim')
    process.exit(2)
  }
  process.exit(0)
}

if (import.meta.main) main()
