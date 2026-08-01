'use strict'

/**
 * Dual-harness hook input (Claude Code + Grok).
 *
 * Claude often injects CLAUDE_TOOL_INPUT / CLAUDE_FILE_PATHS env vars.
 * Grok posts a JSON envelope on stdin (toolName, toolInput, …) and sets
 * GROK_* / CLAUDE_PLUGIN_ROOT aliases for plugin hooks.
 *
 * Prefer: env (Claude) ∪ stdin envelope (Grok) ∪ both when present.
 */

const fs = require('node:fs')

/**
 * Prefer env (Claude) so we never block on an open empty stdin.
 * Only read stdin when Claude env is absent (Grok envelope path).
 * @returns {object|null}
 */
function readStdinJsonSync() {
  try {
    if (process.stdin.isTTY) return null
    const raw = fs.readFileSync(0, 'utf8')
    if (!raw || !raw.trim()) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * @returns {{ toolName: string|null, toolInput: object, filePaths: string[], envelope: object|null }}
 */
function loadHookInput() {
  let toolInput = {}
  let toolName = null
  let envelope = null

  // Claude path: env present → do not touch stdin (avoids hang if pipe left open)
  const hasClaudeEnv = !!(
    process.env.CLAUDE_TOOL_INPUT ||
    process.env.CLAUDE_FILE_PATHS
  )

  if (process.env.CLAUDE_TOOL_INPUT) {
    try {
      const fromEnv = JSON.parse(process.env.CLAUDE_TOOL_INPUT)
      if (fromEnv && typeof fromEnv === 'object') toolInput = fromEnv
    } catch {
      // ignore malformed env
    }
  }

  if (!hasClaudeEnv) {
    envelope = readStdinJsonSync()
    if (envelope && typeof envelope === 'object') {
      toolName = envelope.toolName || envelope.tool_name || null
      const ti = envelope.toolInput || envelope.tool_input
      if (ti && typeof ti === 'object') toolInput = ti
    }
  }

  const filePaths = []

  if (process.env.CLAUDE_FILE_PATHS) {
    for (const p of process.env.CLAUDE_FILE_PATHS.split('\n')) {
      const t = p.trim()
      if (t) filePaths.push(t)
    }
  }

  // Single path fields (Claude Edit/Write + Grok search_replace/write)
  for (const key of ['file_path', 'filePath', 'path']) {
    const v = toolInput[key]
    if (typeof v === 'string' && v.trim()) filePaths.push(v.trim())
  }

  const seen = new Set()
  const uniq = []
  for (const p of filePaths) {
    if (!seen.has(p)) {
      seen.add(p)
      uniq.push(p)
    }
  }

  return { toolName, toolInput, filePaths: uniq, envelope }
}

/**
 * Content being written (security scan target).
 * @param {object} toolInput
 * @returns {string}
 */
function extractWriteContent(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return ''
  return (
    toolInput.content ||
    toolInput.new_string ||
    toolInput.newString ||
    toolInput.new_str ||
    ''
  )
}

/**
 * Shell command string when tool is Bash / run_terminal_command.
 * @param {object} toolInput
 * @returns {string}
 */
function extractShellCommand(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return ''
  return toolInput.command || toolInput.cmd || ''
}

module.exports = {
  loadHookInput,
  extractWriteContent,
  extractShellCommand,
  readStdinJsonSync,
}
