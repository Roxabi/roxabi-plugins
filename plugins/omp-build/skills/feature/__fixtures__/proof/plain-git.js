/**
 * The Git a landing admission (#768) reads in a checkout of `head` that commits
 * neither `.semctx` nor an assertledger adapter: it admits without a gh call.
 * `toplevel` must be a real directory with no `.semctx` — admission lstat()s it.
 * Any other git call fails, so a test sees an unexpected read as a refusal.
 *
 * @param {string} head
 * @param {string} toplevel
 * @returns {(cwd: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function plainGit(head, toplevel) {
  const answers = {
    'rev-parse --show-toplevel': `${toplevel}\n`,
    'rev-parse --verify HEAD^{commit}': `${head}\n`,
    'worktree list --porcelain -z': `worktree ${toplevel}\0HEAD ${head}\0detached\0\0`,
  }
  return async (_cwd, args) => {
    const key = args.join(' ')
    if (Object.hasOwn(answers, key)) return { code: 0, stdout: answers[key], stderr: '' }
    if (args[0] === 'ls-tree' && args.includes(`${head}^{commit}`)) return { code: 0, stdout: '', stderr: '' }
    return { code: 128, stdout: '', stderr: `plainGit: no answer for git ${key}` }
  }
}
