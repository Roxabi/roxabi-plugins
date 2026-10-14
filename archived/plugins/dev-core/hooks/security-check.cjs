#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

// Fail-closed dependency load — deliberate, and deliberately asymmetric.
//
// Claude Code and Grok only *block* a tool call on exit code 2; exit 1 is
// reported as a non-blocking hook error. An uncaught MODULE_NOT_FOUND here
// (partial or stale install in the hash-keyed plugin cache) therefore lets the
// write through completely unscanned, with nothing but a warning. A secret
// scanner that degrades to "allow" is the worst possible failure mode, so a
// load failure must deny instead.
//
// The failure path must not use any required module — emitDeny lives in one of
// them and may be exactly what failed — hence raw stderr + process.exit(2).
//
// Scope: security-check ONLY. The convenience guards (bun-test-guard.cjs,
// principal-branch-pre/post.cjs, format.cjs) stay fail-open on purpose —
// failing closed there would lock the user out of every Bash command for no
// security benefit. This asymmetry is the design, not an oversight.

/**
 * @param {string} id
 * @param {string} detail
 * @returns {never}
 */
function denyUnavailable(id, detail) {
  process.stderr.write(
    `security-check: cannot load ${id} — secret scanning is unavailable, refusing to proceed. ` +
      'Reinstall the plugin: claude plugin install dev-core\n',
  )
  process.stderr.write(`security-check: ${detail}\n`)
  process.exit(2)
}

/**
 * Require a hook dependency, or deny the tool call if it is unusable.
 * @param {string} id
 * @param {string[]} names exports the caller depends on
 * @returns {Record<string, any>}
 */
function requireOrDeny(id, names) {
  let mod
  try {
    mod = require(id)
  } catch (e) {
    denyUnavailable(id, e?.message ? e.message : String(e))
  }
  const missing = names.filter((n) => mod[n] == null)
  if (missing.length > 0) {
    denyUnavailable(id, `missing export(s): ${missing.join(', ')}`)
  }
  return mod
}

const { loadHookInput, extractWriteContent } = requireOrDeny('./lib/hook-input.cjs', [
  'loadHookInput',
  'extractWriteContent',
])
const { SECURITY_PATTERNS } = requireOrDeny('./lib/security-patterns.cjs', ['SECURITY_PATTERNS'])
const { emitDeny } = requireOrDeny('./lib/principal-freeze.cjs', ['emitDeny'])

const PROJECT_ROOT = process.cwd()
const STATE_DIR = path.join(PROJECT_ROOT, '.claude', 'security_warnings')
const today = new Date().toISOString().slice(0, 10)
const STATE_FILE = path.join(STATE_DIR, `${today}.json`)

function pruneOldStateFiles() {
  const MAX_AGE_DAYS = 7
  try {
    const files = fs.readdirSync(STATE_DIR)
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const filePath = path.join(STATE_DIR, file)
      const stat = fs.statSync(filePath)
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath)
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { warnings: {} }
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function toRelativePath(filePath) {
  return path.relative(PROJECT_ROOT, filePath) || filePath
}

function getWarningKey(file, ruleId) {
  return `${toRelativePath(file)}:${ruleId}`
}

function checkContent(content, filePath, state) {
  const blocked = []

  for (const rule of SECURITY_PATTERNS) {
    if (rule.pattern.test(content)) {
      const key = getWarningKey(filePath, rule.id)
      if (!state.warnings[key]) {
        blocked.push(rule.message)
        state.warnings[key] = Date.now()
      }
    }
    rule.pattern.lastIndex = 0
  }

  return blocked
}

function main() {
  // Same fail-closed rationale as the dependency load above: an exception
  // mid-scan means the content was NOT fully scanned, so exit 2 (deny) rather
  // than 0 (allow). The whole body is inside the try on purpose — a throw from
  // loadHookInput/extractWriteContent must deny too, not fall through to an
  // uncaught exit 1, which the harness treats as non-blocking.
  try {
    pruneOldStateFiles()

    const { toolInput, filePaths } = loadHookInput()
    const content = extractWriteContent(toolInput)
    if (!content) {
      process.exit(0)
    }

    const filePath = filePaths[0] || toolInput.file_path || toolInput.filePath || 'unknown'

    const state = loadState()
    const warningsBefore = Object.keys(state.warnings).length
    const blocked = checkContent(content, filePath, state)
    const dirty = Object.keys(state.warnings).length > warningsBefore

    if (dirty) {
      saveState(state)
    }

    if (blocked.length > 0) {
      emitDeny(`Security check:\n${blocked.map((w) => `- ${w}`).join('\n')}`)
    }
  } catch (e) {
    process.stderr.write(
      'security-check: scan failed — content was not fully scanned, refusing to proceed. ' +
        'Reinstall the plugin: claude plugin install dev-core\n',
    )
    process.stderr.write(`security-check: ${e?.message ? e.message : String(e)}\n`)
    process.exit(2)
  }
}

main()
