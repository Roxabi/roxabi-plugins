#!/usr/bin/env bun

/**
 * Verify every action SHA the generators emit is a real commit, and that none
 * escapes ACTION_PINS.
 *
 * Usage:
 *   bun run tools/verify-action-pins.ts            — verify pins resolve + are governed
 *   bun run tools/verify-action-pins.ts --tags     — also report pins that drifted off their tag
 *
 * These pins live in a TypeScript constant, not in a workflow file, so Dependabot
 * never sees them and nothing else proves the SHAs exist. Two hallucinated SHAs
 * (setup-node, setup-uv) shipped this way and would have failed every generated
 * CI run at "Set up job". A length check is not enough — one of the two was a
 * well-formed 40-char SHA that simply did not exist. Only the API answers that.
 *
 * Resolving ACTION_PINS alone is also not enough: a pin written inline in a
 * generator template bypasses the constant entirely and this check with it
 * (fetch-metadata sat at v2.5.0 that way). So every `uses: owner/repo@ref`
 * literal in the emitter sources must match an (action, sha) pair that
 * ACTION_PINS declares — matching the SHA alone would let a floating tag
 * (unpinned) or a wrong action reusing a governed SHA slip through unflagged.
 *
 * Requires network + gh auth (GITHUB_TOKEN in CI). Exits 1 on any unresolvable
 * or ungoverned pin.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..')
const PINS_PATH = resolve(REPO_ROOT, 'plugins/dev-core/skills/shared/workflows/workflow-pins.ts')

/** Sources that emit workflow YAML, all canonical in dev-core's copy-synced skills/shared.
 *  github-infra.ts keeps its create-app-token pin inline rather than importing ACTION_PINS
 *  (it now could — same skills/shared tree post-#359 — but that would couple adapters/ to
 *  workflows/); as an inline literal it is scanned here so it stays governed, and both plugin
 *  copies are listed since each carries the literal independently. */
const EMITTER_PATHS = [
  'plugins/dev-core/skills/shared/workflows/workflows.ts',
  'plugins/dev-core/skills/shared/workflows/workflows-fleet.ts',
  'plugins/dev-init/skills/shared/adapters/github-infra.ts',
  'plugins/dev-core/skills/shared/adapters/github-infra.ts',
]

const checkTags = process.argv.includes('--tags')

export interface Pin {
  name: string
  action: string
  sha: string
  tag: string
}

export function parsePins(source: string): Pin[] {
  const re = /(\w+):\s*'([^@']+)@([0-9a-fA-F]+)',\s*\/\/\s*(\S+)/g
  return [...source.matchAll(re)].map((m) => ({ name: m[1], action: m[2], sha: m[3], tag: m[4] }))
}

export interface InlineRef {
  action: string
  ref: string
}

export interface InlinePin extends InlineRef {
  file: string
}

const HEX_SHA_RE = /^[0-9a-fA-F]{7,}$/

/** `uses: owner/repo@<ref>` literal, `ref` being anything up to whitespace/quote/comment —
 *  a floating tag (`@v3`) must be caught same as a SHA, or it is a worse, invisible bypass.
 *  The action pattern (`word.-/word.-`) already excludes `${ACTION_PINS.x}` template refs:
 *  they contain no `/` before the `@`, so the whole match fails to anchor on those lines. */
export function parseInlinePins(source: string): InlineRef[] {
  const re = /uses:\s*([\w.-]+\/[\w.-]+)@([^\s'"#]+)/g
  return [...source.matchAll(re)].map((m) => ({ action: m[1], ref: m[2] }))
}

export function findInlinePins(files: string[]): InlinePin[] {
  return files.flatMap((file) => {
    const source = readFileSync(resolve(REPO_ROOT, file), 'utf-8')
    return parseInlinePins(source).map((pin) => ({ file, ...pin }))
  })
}

function governedKey(action: string, ref: string): string {
  return `${action}@${ref}`.toLowerCase()
}

export function buildGovernedPairs(pins: Pin[]): Set<string> {
  return new Set(pins.map((p) => governedKey(p.action, p.sha)))
}

/** An inline pin is governed only when its (action, ref) pair matches ACTION_PINS —
 *  matching the ref/SHA alone would let a wrong-action reuse of a governed SHA, or a
 *  floating tag on an otherwise-governed action, pass silently. */
export function findUngovernedPins(inlinePins: InlinePin[], governedPairs: Set<string>): InlinePin[] {
  return inlinePins.filter((pin) => !governedPairs.has(governedKey(pin.action, pin.ref)))
}

async function gh(path: string): Promise<unknown | null> {
  const proc = Bun.spawnSync(['gh', 'api', path], { stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) return null
  try {
    return JSON.parse(proc.stdout.toString())
  } catch {
    return null
  }
}

/** Resolve a tag ref to its commit, dereferencing annotated tags (object.type === 'tag'). */
async function commitForTag(action: string, tag: string): Promise<string | null> {
  const ref = (await gh(`repos/${action}/git/ref/tags/${tag}`)) as { object?: { sha?: string; type?: string } } | null
  const obj = ref?.object
  if (!obj?.sha) return null
  if (obj.type !== 'tag') return obj.sha
  const deref = (await gh(`repos/${action}/git/tags/${obj.sha}`)) as { object?: { sha?: string } } | null
  return deref?.object?.sha ?? null
}

async function main() {
  const pins = parsePins(readFileSync(PINS_PATH, 'utf-8'))
  if (pins.length === 0) {
    console.error(`No pins parsed from ${PINS_PATH} — the file shape changed and this check is now blind.`)
    process.exit(1)
  }

  let failed = 0
  for (const pin of pins) {
    const commit = (await gh(`repos/${pin.action}/commits/${pin.sha}`)) as { sha?: string } | null
    if (!commit?.sha) {
      failed++
      const actual = await commitForTag(pin.action, pin.tag)
      console.error(`FAIL ${pin.name}: ${pin.action}@${pin.sha} is not a commit (${pin.sha.length} chars)`)
      if (actual) console.error(`     ${pin.tag} is ${actual}`)
      continue
    }
    if (!checkTags) {
      console.log(`ok   ${pin.name}: ${pin.action}@${pin.sha.slice(0, 12)} (${pin.tag})`)
      continue
    }
    const tagSha = await commitForTag(pin.action, pin.tag)
    const drifted = tagSha && tagSha !== pin.sha
    console.log(
      drifted
        ? `drift ${pin.name}: pinned ${pin.sha.slice(0, 12)}, ${pin.tag} now ${tagSha.slice(0, 12)}`
        : `ok   ${pin.name}: ${pin.action}@${pin.sha.slice(0, 12)} (${pin.tag})`,
    )
  }

  const governedPairs = buildGovernedPairs(pins)
  const ungovernedPins = findUngovernedPins(findInlinePins(EMITTER_PATHS), governedPairs)
  for (const inline of ungovernedPins) {
    const reason = HEX_SHA_RE.test(inline.ref) ? 'not declared in ACTION_PINS' : 'floating ref, not pinned to a SHA'
    console.error(`FAIL ${inline.file}: uses ${inline.action}@${inline.ref} — ${reason}`)
    console.error('     Add it to workflow-pins.ts and reference it, or this pin is never verified.')
  }

  if (failed > 0 || ungovernedPins.length > 0) {
    if (failed > 0)
      console.error(`\n${failed}/${pins.length} pins do not resolve — generated CI would fail at "Set up job".`)
    if (ungovernedPins.length > 0) console.error(`${ungovernedPins.length} inline pin(s) bypass ACTION_PINS.`)
    process.exit(1)
  }
  console.log(`\nAll ${pins.length} pins resolve; no inline pin bypasses ACTION_PINS.`)
}

if (import.meta.main) {
  await main()
}
