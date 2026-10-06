import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `git ls-tree -z HEAD <dir>/` of a tree whose files on disk are the commit: object ids are
 * the paths. As in git, a `<dir>` reached through a symlink is no tree, so it lists nothing.
 */
function listing(root: string, dir: string): string {
  const parts = dir.split('/').filter(Boolean)
  for (let depth = 1; depth <= parts.length; depth++) {
    try {
      if (!lstatSync(join(root, ...parts.slice(0, depth))).isDirectory()) return ''
    } catch {
      return ''
    }
  }
  return readdirSync(join(root, dir))
    .sort()
    .map((name) => {
      const path = `${dir}${name}`
      const stat = lstatSync(join(root, path))
      const [mode, type] = stat.isSymbolicLink()
        ? ['120000', 'blob']
        : stat.isDirectory()
          ? ['040000', 'tree']
          : ['100644', 'blob']
      return `${mode} ${type} ${path}\t${path}`
    })
    .join('\0')
}

/**
 * The `git` of a checkout whose files on disk are exactly what is committed at `head`. Its
 * root is the `cwd` it is asked about; its principal is that root unless given. The unit
 * tests never fork, so the proof gate gets this instead of the real `git`; the real one runs
 * in `proof-gate.integration.test.ts`.
 */
export function checkoutGit({
  head = '0123456789abcdef0123456789abcdef01234567',
  principal,
  noRoot = false,
  calls,
}: {
  head?: string
  principal?: string
  noRoot?: boolean
  calls?: string[][]
} = {}) {
  return async (cwd: string, args: string[]): Promise<string> => {
    calls?.push(args)
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      if (noRoot) throw new Error('fatal: not a git repository')
      return cwd
    }
    if (args[0] === 'worktree') return `worktree ${principal ?? cwd}\n`
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return head
    if (args[0] === 'ls-tree' && args[2] === 'HEAD') return listing(cwd, args[3] ?? '')
    if (args[0] === 'cat-file' && args[1] === 'blob') return readFileSync(join(cwd, args[2] ?? ''), 'utf8')
    throw new Error(`unexpected git ${args.join(' ')}`)
  }
}
