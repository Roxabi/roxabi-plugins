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
    if (!raw?.trim()) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * @returns {{ toolName: string|null, toolInput: object, filePaths: string[], envelope: object|null }}
 */
function loadHookInput() {
  const claudeInput = claudeToolInput()
  const hasClaudeEnv = Boolean(process.env.CLAUDE_TOOL_INPUT || process.env.CLAUDE_FILE_PATHS)
  const envelope = hasClaudeEnv ? null : readStdinJsonSync()
  const grokInput = envelopeInput(envelope)
  const toolInput = claudeInput || grokInput.toolInput || {}
  return {
    toolName: grokInput.toolName,
    toolInput,
    filePaths: uniquePaths(claudeFilePaths().concat(toolInputPaths(toolInput))),
    envelope,
  }
}

function claudeToolInput() {
  const raw = process.env.CLAUDE_TOOL_INPUT
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function envelopeInput(envelope) {
  if (!envelope || typeof envelope !== 'object') return { toolName: null, toolInput: null }
  const toolInput = envelope.toolInput || envelope.tool_input
  return {
    toolName: envelope.toolName || envelope.tool_name || null,
    toolInput: toolInput && typeof toolInput === 'object' ? toolInput : null,
  }
}

function claudeFilePaths() {
  const raw = process.env.CLAUDE_FILE_PATHS
  return raw
    ? raw
        .split('\n')
        .map((path) => path.trim())
        .filter(Boolean)
    : []
}

function toolInputPaths(toolInput) {
  return ['file_path', 'filePath', 'path']
    .map((key) => toolInput[key])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
}

function uniquePaths(paths) {
  return [...new Set(paths)]
}

/**
 * Content being written (security scan target).
 * @param {object} toolInput
 * @returns {string}
 */
function extractWriteContent(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return ''
  return toolInput.content || toolInput.new_string || toolInput.newString || toolInput.new_str || ''
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
