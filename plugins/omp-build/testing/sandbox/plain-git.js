/**
 * The Git a landing admission (#768) reads in a checkout of `head`.
 * Any other git call fails, so a test sees an unexpected read as a refusal.
 *
 * @param {string} head
 * @param {string} [baseTip=head]
 * @returns {(cwd: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function plainGit(head, baseTip = head) {
  const answers = {
    'rev-parse --verify HEAD^{commit}': `${head}\n`,
    'remote get-url origin': 'https://github.com/acme/app.git\n',
  }
  return async (_cwd, args) => {
    const key = args.join(' ')
    if (Object.hasOwn(answers, key)) return { code: 0, stdout: answers[key], stderr: '' }
    if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'rev-parse' && /^refs\/remotes\/origin\/[^\s]+\^\{commit\}$/.test(args[2] ?? ''))
      return { code: 0, stdout: `${baseTip}\n`, stderr: '' }
    if (args[0] === 'ls-tree' && (args.includes(`${head}^{commit}`) || args.includes(`${baseTip}^{commit}`)))
      return { code: 0, stdout: '', stderr: '' }
    return { code: 128, stdout: '', stderr: `plainGit: no answer for git ${key}` }
  }
}
