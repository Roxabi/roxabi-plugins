/**
 * Worktree Scaffold — Checklist-driven worktree-setup script composer
 *
 * Parses plugins/dev-core/references/worktree-setup-checklist.md and selects
 * concerns matching a project's ProjectContext, then composes the snippets
 * into tools/worktree-setup.sh / tools/worktree-teardown.sh for user projects.
 *
 * Usage:
 *   bun plugins/dev-core/tools/worktreeScaffold.ts compose --checklist <path> \
 *     --context-json <inline-json> --mode setup|teardown
 *
 * Zero external dependencies — uses Node built-ins only.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Concern {
  id: string
  applies_when: string[]
  setup_snippet: string
  teardown_snippet: string
  validation: string
}

export interface Checklist {
  version: number
  concerns: Concern[]
}

export interface ProjectContext {
  runtime: string
  package_manager: string
  monorepo: boolean
  hooks_tool: string
  env_files: string[]
  database: string
  backend_paths: string[]
}

// ─── YAML Mini-Parser ────────────────────────────────────────────────────────

function parseFrontmatterVersion(raw: string): number {
  const match = raw.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return 1
  const vLine = match[1].split('\n').find((l) => l.startsWith('version:'))
  if (!vLine) return 1
  return Number(vLine.replace('version:', '').trim())
}

function extractYamlBlock(raw: string): string {
  // The block lives under ## Concerns, fenced with ```yaml ... ```
  const afterHeading = raw.slice(raw.indexOf('## Concerns'))
  const start = afterHeading.indexOf('```yaml')
  const end = afterHeading.indexOf('```', start + 7)
  if (start === -1 || end === -1) throw new Error('No ```yaml block found under ## Concerns')
  return afterHeading.slice(start + 7, end).trim()
}

function parseInlineArray(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[')) return [trimmed.replace(/^["']|["']$/g, '')]
  // Require JSON-style double-quoted strings; single-quote rewriting corrupts apostrophes
  try {
    return JSON.parse(trimmed) as string[]
  } catch {
    throw new Error('applies_when must be a JSON-style array of strings (use double quotes)')
  }
}

function parseBlockScalar(lines: string[], startIndex: number): { value: string; nextIndex: number } {
  // Collect lines indented ≥4 spaces (list-item indent 2 + key indent 2)
  const collected: string[] = []
  let i = startIndex
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('\t')) {
      throw new Error(
        `tab indentation not supported in concern block scalar (line: ${JSON.stringify(line)}). Use 4 spaces.`,
      )
    }
    if (line === '' || line.startsWith('    ')) {
      collected.push(line.startsWith('    ') ? line.slice(4) : '')
      i++
    } else {
      break
    }
  }
  // Trim trailing blank lines
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
  return { value: collected.join('\n'), nextIndex: i }
}

function parseConcerns(yaml: string): Concern[] {
  const lines = yaml.split('\n')
  const concerns: Concern[] = []
  let i = 0

  while (i < lines.length) {
    if (!lines[i].startsWith('- id:')) {
      i++
      continue
    }

    const concern: Partial<Concern> = {}
    concern.id = lines[i].replace('- id:', '').trim()
    i++

    while (i < lines.length && !lines[i].startsWith('- id:')) {
      const line = lines[i]
      const trimmed = line.trimStart()

      if (trimmed.startsWith('applies_when:')) {
        concern.applies_when = parseInlineArray(trimmed.replace('applies_when:', '').trim())
        i++
      } else if (trimmed.startsWith('setup_snippet: |')) {
        const result = parseBlockScalar(lines, i + 1)
        concern.setup_snippet = result.value
        i = result.nextIndex
      } else if (trimmed.startsWith('teardown_snippet: |')) {
        const result = parseBlockScalar(lines, i + 1)
        concern.teardown_snippet = result.value
        i = result.nextIndex
      } else if (trimmed.startsWith('validation:')) {
        concern.validation = trimmed
          .replace('validation:', '')
          .trim()
          .replace(/^["']|["']$/g, '')
        i++
      } else {
        i++
      }
    }

    const required: (keyof Concern)[] = ['id', 'applies_when', 'setup_snippet', 'teardown_snippet', 'validation']
    for (const field of required) {
      if (concern[field] === undefined) {
        throw new Error(`Invalid concern: missing field ${field} in id ${concern.id ?? '(unknown)'}`)
      }
    }

    concerns.push(concern as Concern)
  }

  return concerns
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function parseChecklist(filePath: string): Checklist {
  let raw = readFileSync(filePath, 'utf-8')
  // Normalise CRLF → LF before any splitting so the parser never sees \r
  raw = raw.replace(/\r\n/g, '\n')
  const version = parseFrontmatterVersion(raw)
  const yamlBlock = extractYamlBlock(raw)
  const concerns = parseConcerns(yamlBlock)
  return { version, concerns }
}

export function selectConcerns(ctx: ProjectContext, checklist: Checklist): Concern[] {
  return checklist.concerns.filter((concern) => {
    return concern.applies_when.every((expr) => {
      const eqIdx = expr.indexOf('=')
      if (eqIdx === -1) return false
      const key = expr.slice(0, eqIdx)
      const value = expr.slice(eqIdx + 1)

      // env_files=present is a special sentinel — not a string compare
      if (key === 'env_files' && value === 'present') return ctx.env_files.length > 0

      if (!(key in ctx)) return false
      const ctxVal = ctx[key as keyof ProjectContext]

      if (key === 'monorepo') return ctxVal === (value === 'true')

      return ctxVal === value
    })
  })
}

const HEADER_COMMENT = '# Generated by dev-core worktreeScaffold — do not edit by hand.'
const REGEN_COMMENT = '# Re-generate with: /stack-setup --force (or /env-setup retrofit)'

export function composeScript(concerns: Concern[], mode: 'setup' | 'teardown'): string {
  const ids = concerns.map((c) => c.id).join(', ') || '(none)'
  const lines: string[] = [
    '#!/usr/bin/env bash',
    HEADER_COMMENT,
    `# Concerns: ${ids}`,
    REGEN_COMMENT,
    'set -euo pipefail',
  ]

  if (concerns.length === 0) {
    lines.push('')
    lines.push('# (no concerns matched this project context)')
    lines.push('exit 0')
    lines.push('')
    return lines.join('\n')
  }

  const snippet = (c: Concern) => (mode === 'setup' ? c.setup_snippet : c.teardown_snippet)

  // For teardown, trivially empty concerns (bare `:` or `: # comment`) go last.
  // Recognised no-op forms: `:`, `: # comment`, `:\t`, etc.
  function isNoopTeardown(body: string): boolean {
    return /^:\s*(#.*)?\s*$/.test(body.trim())
  }

  let ordered = concerns
  if (mode === 'teardown') {
    ordered = [
      ...concerns.filter((c) => !isNoopTeardown(snippet(c))),
      ...concerns.filter((c) => isNoopTeardown(snippet(c))),
    ]
  }

  for (const concern of ordered) {
    const divider = `# ─── ${concern.id} ──────────────────────────────────────────`
    lines.push('')
    lines.push(divider)
    lines.push(snippet(concern))
  }

  lines.push('')
  return lines.join('\n')
}

// ─── Retrofit Detection ──────────────────────────────────────────────────────

export function shouldOfferRetrofit(stackYamlContent: string, repoRoot: string): boolean {
  if (/worktree_setup:/m.test(stackYamlContent)) return false
  // Strip optional quotes and trailing comments; be permissive if unparseable (offer retrofit)
  const runtimeMatch = stackYamlContent.match(/^runtime:\s*["']?([\w-]+)["']?\s*(#.*)?$/m)
  if (!runtimeMatch) return true
  const runtime = runtimeMatch[1]
  if (!['python', 'bun', 'node'].includes(runtime)) return false
  if (existsSync(join(repoRoot, 'tools/worktree-setup.sh'))) return false
  return true
}

// ─── CLI Entry ───────────────────────────────────────────────────────────────

const USAGE = `Usage:
  worktreeScaffold parse --checklist <path>
  worktreeScaffold compose --checklist <path> --context-json <json> --mode setup|teardown
  worktreeScaffold list-selected --checklist <path> --context-json <json>`

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx !== -1 ? args[idx + 1] : undefined
}

function requireArg(args: string[], flag: string): string {
  const value = getArg(args, flag)
  if (value === undefined) {
    process.stderr.write(`Missing required ${flag}\n\n${USAGE}\n`)
    process.exit(2)
  }
  return value
}

function parseContextJson(raw: string): ProjectContext {
  try {
    return JSON.parse(raw) as ProjectContext
  } catch {
    process.stderr.write('context-json: invalid JSON\n')
    process.exit(2)
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const cmd = args[0]

  if (cmd === 'parse') {
    const checklistPath = requireArg(args, '--checklist')
    const result = parseChecklist(checklistPath)
    console.log(JSON.stringify(result, null, 2))
    process.exit(0)
  }

  if (cmd === 'compose') {
    const checklistPath = requireArg(args, '--checklist')
    const contextRaw = requireArg(args, '--context-json')
    const mode = requireArg(args, '--mode') as 'setup' | 'teardown'
    const checklist = parseChecklist(checklistPath)
    const ctx = parseContextJson(contextRaw)
    const concerns = selectConcerns(ctx, checklist)
    process.stdout.write(composeScript(concerns, mode))
    process.exit(0)
  }

  if (cmd === 'list-selected') {
    const checklistPath = requireArg(args, '--checklist')
    const contextRaw = requireArg(args, '--context-json')
    const checklist = parseChecklist(checklistPath)
    const ctx = parseContextJson(contextRaw)
    const concerns = selectConcerns(ctx, checklist)
    console.log(concerns.map((c) => c.id).join(', '))
    process.exit(0)
  }

  process.stderr.write(`Unknown command: ${cmd ?? '(none)'}\n\n${USAGE}\n`)
  process.exit(1)
}
