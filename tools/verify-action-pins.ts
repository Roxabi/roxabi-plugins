#!/usr/bin/env bun

/**
 * Verify committed GitHub Actions workflow references are immutable SHA pins
 * that resolve to real commits for their actions.
 *
 * After the archive cutover, generator ACTION_PINS / emitter scans no longer
 * apply. Provenance for pinned tooling still requires: (1) no floating tags in
 * committed workflows, (2) each 40-hex SHA resolves via the GitHub API for that
 * action. A length check alone shipped non-existent SHAs before (#375 lineage).
 *
 * Requires network + gh auth (GITHUB_TOKEN in CI).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..')
const HEX_SHA_RE = /^[0-9a-fA-F]{40}$/

export interface InlineRef {
  action: string
  ref: string
}

export interface InlinePin extends InlineRef {
  file: string
}

/** Parse quoted and unquoted `uses: owner/repo@ref` workflow values. */
export function parseInlinePins(source: string): InlineRef[] {
  const re = /uses:\s*(?:["']\s*)?([\w.-]+\/[\w.-]+)@([^\s'"#]+)(?:\s*["'])?/g
  return [...source.matchAll(re)].map((match) => ({ action: match[1], ref: match[2] }))
}

export function findInlinePins(files: string[]): InlinePin[] {
  return files.flatMap((file) => {
    const source = readFileSync(resolve(REPO_ROOT, file), 'utf-8')
    return parseInlinePins(source).map((pin) => ({ file, ...pin }))
  })
}

function workflowFiles(dir = '.github/workflows'): string[] {
  const absDir = resolve(REPO_ROOT, dir)
  return readdirSync(absDir)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => `${dir}/${file}`)
}

/** Every third-party action in committed workflows must be pinned to a full SHA. */
export function findFloatingWorkflowPins(dir = '.github/workflows'): InlinePin[] {
  return findInlinePins(workflowFiles(dir)).filter((pin) => !HEX_SHA_RE.test(pin.ref))
}

/** Every third-party action pin in committed workflows (floating or SHA). */
export function findWorkflowPins(dir = '.github/workflows'): InlinePin[] {
  return findInlinePins(workflowFiles(dir))
}

export async function ghApi(path: string): Promise<unknown | null> {
  const proc = Bun.spawnSync(['gh', 'api', path], { stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) return null
  try {
    return JSON.parse(proc.stdout.toString())
  } catch {
    return null
  }
}

/** Resolve each SHA pin; returns pins that do not resolve to a commit. */
export async function findUnresolvedWorkflowPins(
  pins: InlinePin[],
  api: (path: string) => Promise<unknown | null> = ghApi,
): Promise<InlinePin[]> {
  const unresolved: InlinePin[] = []
  for (const pin of pins) {
    if (!HEX_SHA_RE.test(pin.ref)) continue
    const commit = (await api(`repos/${pin.action}/commits/${pin.ref}`)) as { sha?: string } | null
    if (!commit?.sha) unresolved.push(pin)
  }
  return unresolved
}

async function main(): Promise<void> {
  const pins = findWorkflowPins()
  const floatingPins = pins.filter((pin) => !HEX_SHA_RE.test(pin.ref))
  for (const pin of floatingPins) {
    console.error(
      `FAIL ${pin.file}: uses ${pin.action}@${pin.ref} — floating ref in a committed workflow; pin to a 40-hex SHA.`,
    )
  }

  const unresolved = await findUnresolvedWorkflowPins(pins)
  for (const pin of unresolved) {
    console.error(`FAIL ${pin.file}: uses ${pin.action}@${pin.ref} — SHA does not resolve as a commit for that action.`)
  }

  if (floatingPins.length > 0 || unresolved.length > 0) {
    if (floatingPins.length > 0) {
      console.error(`${floatingPins.length} committed-workflow pin(s) are floating tags, not SHAs.`)
    }
    if (unresolved.length > 0) {
      console.error(`${unresolved.length} committed-workflow pin(s) do not resolve.`)
    }
    process.exit(1)
  }
  console.log(`All ${pins.length} committed workflow action references are pinned and resolve.`)
}

if (import.meta.main) await main()
