#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { loadHookInput, extractWriteContent } = require('./lib/hook-input.cjs')
const { SECURITY_PATTERNS } = require('./lib/security-patterns.cjs')
const { emitDeny } = require('./lib/principal-freeze.cjs')

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
  pruneOldStateFiles()

  const { toolInput, filePaths } = loadHookInput()
  const content = extractWriteContent(toolInput)
  if (!content) {
    process.exit(0)
  }

  const filePath = filePaths[0] || toolInput.file_path || toolInput.filePath || 'unknown'

  try {
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
    process.stderr.write(`security-check: ${e?.message ? e.message : String(e)}\n`)
    process.exit(0)
  }
}

main()
