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
 * (fetch-metadata sat at v2.5.0 that way). So every `uses: owner/repo@sha`
 * literal in the emitter sources must carry a SHA that ACTION_PINS declares.
 *
 * Requires network + gh auth (GITHUB_TOKEN in CI). Exits 1 on any unresolvable
 * or ungoverned pin.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')
const PINS_PATH = resolve(REPO_ROOT, 'plugins/dev-init/skills/init/lib/workflow-pins.ts')

/** Sources that emit workflow YAML. github-infra.ts is copy-synced from dev-core and
 *  cannot import dev-init's ACTION_PINS, so its inline pin is checked, not rewritten. */
const EMITTER_PATHS = [
  'plugins/dev-init/skills/init/lib/workflows.ts',
  'plugins/dev-init/skills/init/lib/workflows-fleet.ts',
  'plugins/dev-init/skills/shared/adapters/github-infra.ts',
  'plugins/dev-core/skills/shared/adapters/github-infra.ts',
]

const checkTags = process.argv.includes('--tags')

interface Pin {
  name: string
  action: string
  sha: string
  tag: string
}

function parsePins(source: string): Pin[] {
  const re = /(\w+):\s*'([^@']+)@([0-9a-fA-F]+)',\s*\/\/\s*(\S+)/g
  return [...source.matchAll(re)].map((m) => ({ name: m[1], action: m[2], sha: m[3], tag: m[4] }))
}

interface InlinePin {
  file: string
  action: string
  sha: string
}

/** `uses: owner/repo@<sha>` written as a literal rather than via `${ACTION_PINS.x}`. */
function findInlinePins(files: string[]): InlinePin[] {
  const re = /uses:\s*([\w.-]+\/[\w.-]+)@([0-9a-fA-F]{7,})/g
  return files.flatMap((file) => {
    const source = readFileSync(resolve(REPO_ROOT, file), 'utf-8')
    return [...source.matchAll(re)].map((m) => ({ file, action: m[1], sha: m[2] }))
  })
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

const governed = new Set(pins.map((p) => p.sha.toLowerCase()))
let ungoverned = 0
for (const inline of findInlinePins(EMITTER_PATHS)) {
  if (governed.has(inline.sha.toLowerCase())) continue
  ungoverned++
  console.error(`FAIL ${inline.file}: uses ${inline.action}@${inline.sha.slice(0, 12)} — not declared in ACTION_PINS`)
  console.error('     Add it to workflow-pins.ts and reference it, or this pin is never verified.')
}

if (failed > 0 || ungoverned > 0) {
  if (failed > 0)
    console.error(`\n${failed}/${pins.length} pins do not resolve — generated CI would fail at "Set up job".`)
  if (ungoverned > 0) console.error(`${ungoverned} inline pin(s) bypass ACTION_PINS.`)
  process.exit(1)
}
console.log(`\nAll ${pins.length} pins resolve; no inline pin bypasses ACTION_PINS.`)
