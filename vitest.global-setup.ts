import { execFileSync, spawnSync } from 'node:child_process'
import * as path from 'node:path'

/**
 * Fails the run when `core.bare` of the repository it was started in differs
 * at the end from the start.
 *
 * A fixture that runs git with the GIT_DIR a hook exports from a linked
 * worktree reinitialises that repository as bare, and the principal checkout
 * then refuses every work-tree command. vitest.setup.ts strips those variables
 * from every worker; this catches whatever still reaches the shared config, so
 * the corruption fails the push that caused it instead of surfacing hours later.
 *
 * Runs once, in the main process, which keeps the hook's env: it watches the
 * repository the hook was fired from.
 */
export default function watchCoreBare(): (() => void) | undefined {
  let commonDir: string
  try {
    commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined // not run from a git repository: nothing to watch
  }
  const config = path.join(commonDir, 'config')
  const probe = ['config', '--file', config, '--type=bool', '--get', 'core.bare']
  const before = spawnSync('git', probe, { encoding: 'utf8' }).stdout.trim()

  return () => {
    const after = spawnSync('git', probe, { encoding: 'utf8' }).stdout.trim()
    if (after === before) return
    const repair = before
      ? `git config --file ${config} core.bare ${before}`
      : `git config --file ${config} --unset core.bare`
    throw new Error(
      `core.bare in ${config} changed during this test run: ${before || '(unset)'} → ${after || '(unset)'}.\n` +
        'A test ran git with a repository env it inherited (a hook exports GIT_DIR), or another process rewrote it meanwhile.\n' +
        `Repair: ${repair}`,
    )
  }
}
