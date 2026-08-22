#!/usr/bin/env bun
/**
 * Spawn oracle for security-auditor (#419 claim-axis roster).
 * S1: (σ, Δ) → spawn_security_auditor + priced_claim_ok.
 */

import { readFileSync } from 'node:fs'

export const VALID_CLAIMS = new Set(['fail-closed', 'authz', 'ssot'])

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
        .map((t) => t.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
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
  const status = fm[1].match(/^status:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  return status === 'draft'
}

/** Same path/token rule as code-review SKILL security-auditor row. */
export function pathHit(delta: string[]): boolean {
  for (const f of delta) {
    const lower = f.toLowerCase()
    if (/\bauth\b|\bsecret\b|\bcrypto\b/.test(lower)) return true
    if (lower.includes('/auth/')) return true
    if (lower.includes('secret')) return true
    if (lower.includes('crypto')) return true
  }
  return false
}

export function computeSpawn(input: {
  delta: string[]
  claims: string[]
  pricedClaimOk: boolean
  hasPricedFence: boolean
  specDraft: boolean
}): {
  path_hit: boolean
  claims: string[]
  spawn_security_auditor: boolean
  priced_claim_ok: boolean
  review_halt: boolean
} {
  const { delta, pricedClaimOk, hasPricedFence, specDraft } = input
  const path_hit = pathHit(delta)
  const claims = specDraft ? [] : input.claims.filter((c) => VALID_CLAIMS.has(c))
  const hasClaimTags = claims.some((c) => VALID_CLAIMS.has(c))
  const spawn_security_auditor =
    path_hit ||
    (delta.length > 0 && hasClaimTags) ||
    (delta.length > 0 && !pricedClaimOk && hasPricedFence && !specDraft)

  return {
    path_hit,
    claims,
    spawn_security_auditor,
    priced_claim_ok: pricedClaimOk,
    review_halt: false,
  }
}

export function evaluate(specPath: string, deltaPaths: string[]): ReturnType<typeof computeSpawn> {
  const specContent = readFileSync(specPath, 'utf-8')
  const draft = specIsDraft(specContent)
  const parsed = parsePricedFences(specContent)
  return computeSpawn({
    delta: deltaPaths.filter(Boolean),
    claims: parsed.claims,
    pricedClaimOk: parsed.pricedClaimOk,
    hasPricedFence: parsed.hasPricedFence,
    specDraft: draft,
  })
}

function main(): void {
  const args = process.argv.slice(2)
  let specPath = ''
  let diffList = ''
  let json = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--spec' && args[i + 1]) specPath = args[++i]
    else if (args[i] === '--diff-list' && args[i + 1]) diffList = args[++i]
    else if (args[i] === '--json') json = true
  }

  if (!specPath || !diffList) {
    console.error('usage: claim-roster.ts --spec PATH --diff-list FILE [--json]')
    process.exit(1)
  }

  const delta = readFileSync(diffList, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  let result: ReturnType<typeof computeSpawn>
  let parsed: ReturnType<typeof parsePricedFences>
  try {
    const specContent = readFileSync(specPath, 'utf-8')
    parsed = parsePricedFences(specContent)
    result = computeSpawn({
      delta,
      claims: parsed.claims,
      pricedClaimOk: parsed.pricedClaimOk,
      hasPricedFence: parsed.hasPricedFence,
      specDraft: specIsDraft(specContent),
    })
  } catch {
    console.error('claim-roster: unreadable spec or diff list')
    process.exit(1)
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const [k, v] of Object.entries(result)) {
      if (Array.isArray(v)) console.log(`${k}=${JSON.stringify(v)}`)
      else console.log(`${k}=${v}`)
    }
  }

  if (parsed.hasPricedFence && !result.priced_claim_ok) {
    process.exit(2)
  }
  process.exit(0)
}

if (import.meta.main) main()
