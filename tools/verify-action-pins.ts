#!/usr/bin/env bun

/** Verify committed GitHub Actions workflow references are immutable SHA pins. */
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

/** Every third-party action in committed workflows must be pinned to a full SHA. */
export function findFloatingWorkflowPins(dir = '.github/workflows'): InlinePin[] {
  const absDir = resolve(REPO_ROOT, dir)
  const files = readdirSync(absDir)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => `${dir}/${file}`)
  return findInlinePins(files).filter((pin) => !HEX_SHA_RE.test(pin.ref))
}

function main(): void {
  const floatingPins = findFloatingWorkflowPins()
  for (const pin of floatingPins) {
    console.error(`FAIL ${pin.file}: uses ${pin.action}@${pin.ref} — floating ref in a committed workflow; pin to a 40-hex SHA.`)
  }
  if (floatingPins.length > 0) process.exit(1)
  console.log('All committed workflow action references are pinned to 40-hex SHAs.')
}

if (import.meta.main) main()
