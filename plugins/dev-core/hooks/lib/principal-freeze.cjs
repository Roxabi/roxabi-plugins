'use strict'

/**
 * Principal freeze — shared helpers (state axis).
 * Invariant I: principal worktree HEAD ∈ {staging, main, master}
 *
 * PostToolUse = state detect + restore nudge (not an OS-level hard stop).
 * PreToolUse = soft UX only.
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const BASE_BRANCHES = new Set(['staging', 'main', 'master'])

/** Env keys that must not redirect hook git probes to a decoy repo. */
const GIT_ENV_STRIP = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_INDEX_FILE',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_DIR_CEILING',
]

const DENY_REASON_PRE =
  'Principal freeze (pre): do not move principal off staging|main|master. ' +
  'Feature work → dedicated worktree (/setup-worktree or /dev #N).'

const DENY_REASON_POST =
  'Principal freeze (post): principal HEAD is not on staging|main|master. ' +
  'Restore: git -C <principal> switch staging|main. ' +
  'Feature work belongs in a dedicated worktree.'

const DENY_REASON_PROBE =
  'Principal freeze (post): could not verify principal HEAD (git probe failed). ' +
  'Fix git/PATH or restore principal to staging|main, then retry.'

/**
 * @param {string|null|undefined} name
 * @returns {boolean}
 */
function isBaseBranch(name) {
  if (!name || typeof name !== 'string') return false
  let n = name.trim()
  if (!n || n === 'HEAD') return false
  n = n.replace(/^refs\/heads\//, '')
  n = n.replace(/^refs\/remotes\/[^/]+\//, '')
  n = n.replace(/^origin\//, '')
  return BASE_BRANCHES.has(n)
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function hasEscapeHatch(env = process.env) {
  return env.DEV_CORE_ALLOW_PRINCIPAL_SWITCH === '1'
}

/**
 * Minimal env for hook-owned git probes (strip decoy GIT_*).
 * @returns {NodeJS.ProcessEnv}
 */
function gitProbeEnv() {
  const env = { ...process.env }
  for (const k of GIT_ENV_STRIP) delete env[k]
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_CONFIG')) delete env[k]
  }
  return env
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  if (!a || !b) return false
  try {
    return fs.realpathSync(a) === fs.realpathSync(b)
  } catch {
    return path.resolve(a) === path.resolve(b)
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args after -C cwd
 * @param {{ execFileSync?: typeof execFileSync }} [git]
 * @returns {string}
 */
function gitExec(cwd, args, git = {}) {
  const exec = git.execFileSync || execFileSync
  return exec('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitProbeEnv(),
  }).toString()
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isNotGitError(err) {
  const msg = [
    err && err.message,
    err && err.stderr,
    err && err.stdout,
  ]
    .filter(Boolean)
    .join('\n')
  return /not a git repository/i.test(String(msg))
}

/**
 * @param {string} cwd
 * @param {{ execFileSync?: typeof execFileSync }} [git]
 * @returns {{ status: 'ok', top: string }|{ status: 'not_git' }|{ status: 'probe_error' }}
 */
function showTopLevelStatus(cwd, git = {}) {
  try {
    const top = gitExec(cwd, ['rev-parse', '--show-toplevel'], git).trim()
    if (!top) return { status: 'probe_error' }
    return { status: 'ok', top }
  } catch (e) {
    if (isNotGitError(e)) return { status: 'not_git' }
    return { status: 'probe_error' }
  }
}

/**
 * @param {string} cwd
 * @param {{ execFileSync?: typeof execFileSync }} [git]
 * @returns {string|null}
 */
function showTopLevel(cwd, git = {}) {
  const r = showTopLevelStatus(cwd, git)
  return r.status === 'ok' ? r.top : null
}

/**
 * First porcelain worktree = principal (matches lib.sh principal_worktree_path).
 * @param {string} cwd
 * @param {{ execFileSync?: typeof execFileSync }} [git]
 * @returns {{ status: 'ok', path: string }|{ status: 'not_git' }|{ status: 'probe_error' }}
 */
function principalWorktreeStatus(cwd, git = {}) {
  try {
    const out = gitExec(cwd, ['worktree', 'list', '--porcelain'], git)
    const m = String(out).match(/^worktree (.+)$/m)
    if (!m) return { status: 'probe_error' }
    return { status: 'ok', path: m[1].trim() }
  } catch (e) {
    if (isNotGitError(e)) return { status: 'not_git' }
    return { status: 'probe_error' }
  }
}

/**
 * @param {string} cwd
 * @param {{ execFileSync?: typeof execFileSync }} [git]
 * @returns {string|null}
 */
function principalWorktreePath(cwd, git = {}) {
  const r = principalWorktreeStatus(cwd, git)
  return r.status === 'ok' ? r.path : null
}

/**
 * @param {string} cwd
 * @param {{ execFileSync?: typeof execFileSync }} [git]
 * @returns {boolean}
 */
function isPrincipalCwd(cwd, git = {}) {
  const top = showTopLevel(cwd, git)
  const principal = principalWorktreePath(cwd, git)
  if (!top || !principal) return false
  return samePath(top, principal)
}

/**
 * Resolve principal HEAD for assert.
 * @param {string} [cwd]
 * @param {{ execFileSync?: typeof execFileSync }} [git]
 * @returns {{ status: 'ok', principal: string, branch: string }
 *   | { status: 'not_git' }
 *   | { status: 'probe_error' }}
 */
function principalHead(cwd = process.cwd(), git = {}) {
  const topSt = showTopLevelStatus(cwd, git)
  if (topSt.status === 'not_git') return { status: 'not_git' }
  if (topSt.status === 'probe_error') return { status: 'probe_error' }

  const prinSt = principalWorktreeStatus(cwd, git)
  if (prinSt.status === 'not_git') return { status: 'not_git' }
  if (prinSt.status !== 'ok') return { status: 'probe_error' }

  try {
    const branch = gitExec(
      prinSt.path,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      git,
    ).trim()
    if (!branch) return { status: 'probe_error' }
    return { status: 'ok', principal: prinSt.path, branch }
  } catch (e) {
    if (isNotGitError(e)) return { status: 'not_git' }
    return { status: 'probe_error' }
  }
}

/**
 * Normalize injected or live principalHead results for assertPrincipalOnBase.
 * @param {unknown} info
 * @returns {{ status: 'ok', principal: string, branch: string }
 *   | { status: 'not_git' }
 *   | { status: 'probe_error' }}
 */
function normalizeHeadResult(info) {
  if (info == null) return { status: 'not_git' }
  if (typeof info !== 'object') return { status: 'probe_error' }
  const o = /** @type {Record<string, string>} */ (info)
  if (o.status === 'ok' || o.status === 'not_git' || o.status === 'probe_error') {
    return /** @type {any} */ (info)
  }
  // legacy test inject: { principal, branch }
  if (o.principal && o.branch) {
    return { status: 'ok', principal: o.principal, branch: o.branch }
  }
  return { status: 'probe_error' }
}

/**
 * @param {string} reason
 * @param {number} [code]
 */
function emitDeny(reason, code = 2) {
  process.stdout.write(
    JSON.stringify({ decision: 'deny', reason, message: reason }) + '\n',
  )
  process.stderr.write(reason + '\n')
  process.exit(code)
}

/**
 * PostToolUse: detect off-β principal and nudge restore (agent loop may continue).
 * @param {string} reason
 */
function emitPostAssert(reason) {
  process.stdout.write(
    JSON.stringify({
      decision: 'deny',
      reason,
      message: reason,
      systemMessage: reason,
    }) + '\n',
  )
  process.stderr.write(reason + '\n')
  process.exit(2)
}

module.exports = {
  BASE_BRANCHES,
  DENY_REASON_PRE,
  DENY_REASON_POST,
  DENY_REASON_PROBE,
  isBaseBranch,
  hasEscapeHatch,
  gitProbeEnv,
  samePath,
  showTopLevel,
  showTopLevelStatus,
  principalWorktreePath,
  principalWorktreeStatus,
  isPrincipalCwd,
  principalHead,
  normalizeHeadResult,
  emitDeny,
  emitPostAssert,
}
