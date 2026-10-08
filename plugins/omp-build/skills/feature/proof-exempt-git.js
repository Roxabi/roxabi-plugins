import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Positive no-Semctx facts for unit wrappers. A commit resolves, `ls-tree` of
 * `.semctx` is empty, and the toplevel is a real directory whose `.semctx` is
 * ENOENT. Not an exemption shortcut that throws before the probe.
 */
const root = mkdtempSync(join(tmpdir(), 'proof-exempt-'))
const oid = 'a'.repeat(40)

/** @param {string} _cwd @param {string[]} args */
export async function exemptGit(_cwd, args) {
  if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return root
  if (args[0] === 'worktree' && args[1] === 'list') return `worktree ${root}\n`
  if (args[0] === 'ls-tree') return ''
  if (args[0] === 'rev-parse') return oid
  const error = new Error(`unexpected git ${args.join(' ')}`)
  error.exitCode = 1
  throw error
}
