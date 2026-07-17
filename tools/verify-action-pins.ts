#!/usr/bin/env bun

/**
 * Verify every ACTION_PINS SHA is a real commit in the action's repo.
 *
 * Usage:
 *   bun run tools/verify-action-pins.ts            — verify pins resolve
 *   bun run tools/verify-action-pins.ts --tags     — also report pins that drifted off their tag
 *
 * These pins live in a TypeScript constant, not in a workflow file, so Dependabot
 * never sees them and nothing else proves the SHAs exist. Two hallucinated SHAs
 * (setup-node, setup-uv) shipped this way and would have failed every generated
 * CI run at "Set up job". A length check is not enough — one of the two was a
 * well-formed 40-char SHA that simply did not exist. Only the API answers that.
 *
 * Requires network + gh auth (GITHUB_TOKEN in CI). Exits 1 on any unresolvable pin.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')
const PINS_PATH = resolve(REPO_ROOT, 'plugins/dev-init/skills/init/lib/workflow-pins.ts')

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

if (failed > 0) {
  console.error(`\n${failed}/${pins.length} pins do not resolve — generated CI would fail at "Set up job".`)
  process.exit(1)
}
console.log(`\nAll ${pins.length} pins resolve.`)
