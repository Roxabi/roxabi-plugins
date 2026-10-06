import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The `ls-tree` row of `path`, as git writes it for a file, symlink or directory on the disk. */
function row(root: string, path: string): string {
  const stat = lstatSync(join(root, path))
  const [mode, type] = stat.isSymbolicLink()
    ? ['120000', 'blob']
    : stat.isDirectory()
      ? ['040000', 'tree']
      : ['100644', 'blob']
  return `${mode} ${type} ${path}\t${path}`
}

/**
 * `git ls-tree -z HEAD <path>` of a tree whose files on disk are the commit: object ids are
 * the paths. `dir/` lists the children of `dir`; a path without the slash lists that entry
 * alone. As in git, a path reached through a symlink is in no tree, so it lists nothing.
 */
function listing(root: string, path: string): string {
  const parts = path.split('/').filter(Boolean)
  const listsChildren = path.endsWith('/')
  for (let depth = 1; depth <= parts.length; depth++) {
    const last = depth === parts.length
    try {
      const stat = lstatSync(join(root, ...parts.slice(0, depth)))
      if (!stat.isDirectory() && !(last && !listsChildren)) return ''
    } catch {
      return ''
    }
  }
  if (!listsChildren) return row(root, parts.join('/'))
  return readdirSync(join(root, path))
    .sort()
    .map((name) => row(root, `${path}${name}`))
    .join('\0')
}

/**
 * The `git` of a checkout whose files on disk are exactly what is committed at `head`. Its
 * root is the `cwd` it is asked about; its principal is that root unless given. A local
 * branch is at `branches[name]` (`null`: no such branch), else at `head`. The unit tests
 * never fork, so the proof gate gets this instead of the real `git`; the real one runs in
 * `proof-gate.integration.test.ts`.
 */
export function checkoutGit({
  head = '0123456789abcdef0123456789abcdef01234567',
  principal,
  noRoot = false,
  branches = {},
}: {
  head?: string
  principal?: string
  noRoot?: boolean
  branches?: Record<string, string | null>
} = {}) {
  return async (cwd: string, args: string[]): Promise<string> => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      if (noRoot) throw new Error('fatal: not a git repository')
      return cwd
    }
    if (args[0] === 'worktree') return `worktree ${principal ?? cwd}\n`
    if (args[0] === 'rev-parse' && (args[1] === 'HEAD' || args[3] === 'HEAD^{commit}')) return head
    const ref =
      args[0] === 'rev-parse' && args[1] === '--verify' ? /^refs\/heads\/(.+)\^\{commit\}$/.exec(args[3] ?? '') : null
    if (ref) {
      const tip = Object.hasOwn(branches, ref[1] as string) ? branches[ref[1] as string] : head
      if (tip === null || tip === undefined) throw new Error('git rev-parse --verify: exit 1')
      return tip
    }
    if (args[0] === 'ls-tree' && args[2] === 'HEAD') return listing(cwd, args[3] ?? '')
    if (args[0] === 'cat-file' && args[1] === 'blob') return readFileSync(join(cwd, args[2] ?? ''), 'utf8')
    throw new Error(`unexpected git ${args.join(' ')}`)
  }
}
