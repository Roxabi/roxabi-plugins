/**
 * Which test files fork a real process.
 *
 * A forking test pays for process startup plus whatever the child does, so it
 * belongs in the integration vitest project and its raised budget rather than
 * the 5s default priced for an in-process unit test (#502). Membership is
 * carried by the .integration.test. filename; this module is the predicate
 * that keeps the naming honest.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** Directories that never hold a test vitest runs (mirrors vitest.config.ts exclude). */
const SKIP_DIRS: Record<string, true> = {
  node_modules: true,
  '.git': true,
  '.claude': true,
  '.venv': true,
  dist: true,
}

/** cli/__tests__ runs under bun:test, not vitest — excluded by vitest.config.ts. */
const BUN_TEST_DIR = path.join(path.sep, 'cli', '__tests__', path.sep)

const TEST_FILE = /\.test\.(?:c|m)?[jt]sx?$/

/** The suffix that puts a file in the integration project. */
export const INTEGRATION_SUFFIX = '.integration.test.'

/** Marks where a comment or a string literal stood. Matches \ue000 below. */
const LITERAL = '\ue000'

const SINGLE_QUOTE = "'"
const DOUBLE_QUOTE = '"'
const BACKTICK = '\u0060'

/**
 * Drops comments and wraps every string literal in markers.
 *
 * Detection has to tell code position from data: a real import of
 * child_process forks, whereas the same text quoted inside a test fixture is
 * just data. Keeping the literal value between the markers — rather than
 * erasing it — lets the patterns below demand that a module specifier sit in
 * code, right after an import or require.
 */
function maskLiterals(input: string): string {
  // A marker already in the source would forge a literal span. Nothing in real
  // code uses this private-use codepoint, so dropping it costs nothing.
  const source = input.replaceAll(LITERAL, ' ')
  let out = ''
  let i = 0
  while (i < source.length) {
    const char = source[i]
    const next = source[i + 1]
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (char === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
      out += ' '
      continue
    }
    if (char !== DOUBLE_QUOTE && char !== SINGLE_QUOTE && char !== BACKTICK) {
      out += char
      i++
      continue
    }
    const quote = char
    let body = ''
    i++
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') {
        i += 2
        body += '.'
        continue
      }
      // An unterminated single- or double-quoted string ends at the newline.
      if (source[i] === '\n' && quote !== BACKTICK) break
      body += source[i]
      i++
    }
    i++
    out += LITERAL + body + LITERAL
  }
  return out
}

// The \ue000 in these patterns is LITERAL, the marker maskLiterals emits.
const IMPORTS_CHILD_PROCESS = /(?:from|require\(|import\()\s*\ue000(?:node:)?child_process\ue000/
const MOCKS_CHILD_PROCESS = /vi\.mock\(\s*\ue000(?:node:)?child_process\ue000/
const ANY_LITERAL = /\ue000[^\ue000]*\ue000/g
const BUN_SPAWN = /\bBun\.spawn(?:Sync)?\s*\(/

/**
 * True when the file can reach a real fork, exec or spawn at run time.
 *
 * A binding to child_process that the file mocks away cannot fork — the mock
 * replaces the module. Bun.spawn is a global, so mocking child_process does
 * not neutralise it.
 */
export function forksAProcess(source: string): boolean {
  const masked = maskLiterals(source)
  // A spawn call only counts in code, hence the variant with literal values
  // erased. Module specifiers are the opposite: the value has to survive to be
  // recognised, so they are matched against masked.
  const codeOnly = masked.replace(ANY_LITERAL, '')
  const spawnsViaNode = IMPORTS_CHILD_PROCESS.test(masked) && !MOCKS_CHILD_PROCESS.test(masked)
  return spawnsViaNode || BUN_SPAWN.test(codeOnly)
}

/** Every test file vitest runs, as repo-relative paths. */
export function findTestFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS[entry.name]) walk(full)
        continue
      }
      if (TEST_FILE.test(entry.name) && !full.includes(BUN_TEST_DIR)) found.push(path.relative(root, full))
    }
  }
  walk(root)
  return found.sort()
}
