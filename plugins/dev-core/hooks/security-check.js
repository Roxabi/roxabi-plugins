#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const SECURITY_PATTERNS = [
  {
    id: 'hardcoded-secret',
    pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    message: 'BLOCKED: Potential hardcoded secret detected',
  },
  {
    id: 'sql-injection',
    pattern: /`SELECT.*\$\{|`INSERT.*\$\{|`UPDATE.*\$\{|`DELETE.*\$\{/gi,
    message: 'BLOCKED: Potential SQL injection via template literal interpolation',
  },
  {
    id: 'command-injection',
    pattern: /exec\s*\(\s*`|spawn\s*\(\s*`|execSync\s*\(\s*`/gi,
    message: 'BLOCKED: Potential command injection via template literal',
  },
]

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

function checkContent(content, filePath) {
  const state = loadState()
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

  saveState(state)
  return blocked
}

function main() {
  pruneOldStateFiles()

  const input = process.env.CLAUDE_TOOL_INPUT
  if (!input) {
    process.exit(0)
  }

  try {
    const toolInput = JSON.parse(input)
    const content = toolInput.content || toolInput.new_string || ''
    const filePath = toolInput.file_path || 'unknown'

    if (!content) {
      process.exit(0)
    }

    const blocked = checkContent(content, filePath)

    if (blocked.length > 0) {
      console.log(
        JSON.stringify({
          decision: 'block',
          message: `Security check:\n${blocked.map((w) => `- ${w}`).join('\n')}`,
        })
      )
    }
  } catch {
    process.exit(0)
  }
}

main()
