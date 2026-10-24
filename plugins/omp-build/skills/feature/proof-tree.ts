import { ASSERTLEDGER_CONFIG, type Git, gitError, STACK } from './proof-base'
export type TreeEntry = { mode: string; type: string; oid: string; path: string }

export function parseTree(stdout: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const record of stdout.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    const [mode, type, oid] = record.slice(0, tab).split(' ')
    if (tab < 0 || !mode || !type || !oid) throw new Error(`unreadable ls-tree entry ${JSON.stringify(record)}`)
    entries.push({ mode, type, oid, path: record.slice(tab + 1) })
  }
  return entries
}

export const REGULAR: Record<string, true> = { '100644': true, '100755': true }

export async function blob(git: Git, toplevel: string, entry: TreeEntry): Promise<string> {
  if (entry.type !== 'blob' || !REGULAR[entry.mode]) {
    throw new Error(`${entry.path} is not a regular file (mode ${entry.mode})`)
  }
  const result = await git(toplevel, ['cat-file', 'blob', entry.oid])
  if (result.code !== 0) throw new Error(gitError(['cat-file', 'blob', entry.oid], result))
  return result.stdout
}

/** The entries `rev` commits under the paths applicability reads, or the Git error. */
export async function declarations(git: Git, toplevel: string, rev: string): Promise<TreeEntry[] | Error> {
  const args = ['ls-tree', '-r', '-z', '--full-tree', `${rev}^{commit}`, '--', '.semctx', STACK, ASSERTLEDGER_CONFIG]
  const tree = await git(toplevel, args)
  if (tree.code !== 0) return new Error(gitError(args, tree))
  try {
    return parseTree(tree.stdout)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
