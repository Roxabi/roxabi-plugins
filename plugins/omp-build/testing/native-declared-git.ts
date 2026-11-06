import type { GitRunner } from '../roxabi/workflow-checkout.ts'
import type { DeclaredCheckout, NativeWorldFacts } from './native-implementation-world.ts'

/** Observe only the independently declared commit graph and checkout transitions. */
export function declaredNativeGit(
  commits: ReadonlyMap<string, NativeWorldFacts['commits'][number]>,
  initial: DeclaredCheckout,
) {
  let current = initial
  const checkout = (facts: DeclaredCheckout) => {
    if (
      !commits.has(facts.head) ||
      !commits.has(facts.baseTip) ||
      (facts.remoteTip !== null && !commits.has(facts.remoteTip))
    )
      throw new Error('Checkout refers to undeclared Git commits')
    current = { ...facts }
  }
  checkout(current)
  const ancestor = (base: string, head: string): boolean => {
    const pending = [head],
      seen = new Set<string>()
    for (let sha = pending.pop(); sha !== undefined; sha = pending.pop()) {
      const commit = commits.get(sha)
      if (!commit) throw new Error(`Undeclared Git commit ${sha}`)
      if (sha === base) return true
      if (seen.has(sha)) continue
      seen.add(sha)
      pending.push(...commit.parents)
    }
    return false
  }
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
  const ancestry = (args: readonly string[], key: string) => {
    const base = args[2]
    const head = args[3]
    if (base === undefined || head === undefined || !commits.has(base) || !commits.has(head))
      throw new Error(`Undeclared ancestry ${key}`)
    return { code: ancestor(base, head) ? 0 : 1, stdout: '', stderr: '' }
  }
  const firstParentRange = (args: readonly string[], key: string) => {
    const range = args[3]
    if (range === undefined) throw new Error(`Undeclared range ${key}`)
    const [base, head, ...rest] = range.split('..')
    if (base === undefined || head === undefined || rest.length !== 0 || !commits.has(base) || !commits.has(head))
      throw new Error(`Undeclared range ${key}`)
    const result: string[] = []
    let cursor = head
    while (cursor !== base) {
      const item = commits.get(cursor)
      const parent = item?.parents[0]
      if (!parent) throw new Error(`Non-first-parent range ${key}`)
      result.push(cursor)
      cursor = parent
    }
    return ok(result.reverse().join('\n'))
  }
  const commitDetails = (commit: NativeWorldFacts['commits'][number], key: string) => {
    if (key === `rev-parse --verify ${commit.sha}^{commit}`) return ok(commit.sha)
    if (key === `rev-list --parents -n1 ${commit.sha}`) return ok([commit.sha, ...commit.parents].join(' '))
    if (
      key === `diff-tree --no-commit-id --name-only -r ${commit.sha}` ||
      key === `diff-tree --no-commit-id --name-only -r -m ${commit.sha}`
    )
      return ok(commit.paths.join('\n'))
    if (key === `show -s --format=%s ${commit.sha}`) return ok(commit.subject)
    if (key === `show ${commit.sha}:.dev/stack.yml`)
      return commit.config === null ? { code: 128, stdout: '', stderr: 'path does not exist' } : ok(commit.config)
    return undefined
  }
  const commitObservation = (args: readonly string[], key: string) => {
    const sha =
      args[0] === 'show' && args.length === 2
        ? args[1]?.split(':')[0]
        : args
            .find((arg) => commits.has(arg) || commits.has(arg.replace(/\^\{commit\}$/, '')))
            ?.replace(/\^\{commit\}$/, '')
    const commit = sha === undefined ? undefined : commits.get(sha)
    return commit === undefined ? undefined : commitDetails(commit, key)
  }
  const checkoutHead = (key: string) => {
    if (key === 'rev-parse --verify HEAD^{commit}' || key === 'rev-parse HEAD') return ok(current.head)
    if (key !== 'rev-parse --verify HEAD^{tree}') return undefined
    const commit = commits.get(current.head)
    if (!commit) throw new Error(`Undeclared Git commit ${current.head}`)
    return ok(commit.tree)
  }
  const checkoutObservation = (key: string) => {
    const head = checkoutHead(key)
    if (head !== undefined) return head
    if (key === 'status --porcelain') return ok()
    if (key === 'rev-parse --abbrev-ref HEAD') return ok(current.branch === null ? 'HEAD' : current.branch)
    if (key === `rev-parse --verify origin/${current.base}^{commit}` || key === `rev-parse origin/${current.base}`)
      return ok(current.baseTip)
    return undefined
  }
  const historyObservation = (args: readonly string[], key: string) => {
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor' && args.length === 4) return ancestry(args, key)
    if (args[0] === 'rev-list' && args[1] === '--first-parent' && args[2] === '--reverse' && args.length === 4)
      return firstParentRange(args, key)
    return commitObservation(args, key)
  }
  const fetchBase = (key: string) => {
    if (
      key !== `fetch origin +refs/heads/${current.base}:refs/remotes/origin/${current.base}` ||
      current.branch !== null
    )
      return undefined
    if (current.remoteTip === null) return { code: 1, stdout: '', stderr: 'Base is not published' }
    current = { ...current, baseTip: current.remoteTip }
    return ok()
  }
  const remoteOperation = (key: string) => {
    const fetched = fetchBase(key)
    if (fetched !== undefined) return fetched
    const remoteBranch = current.branch === null ? current.base : current.branch
    if (key === `ls-remote origin refs/heads/${remoteBranch}`)
      return ok(current.remoteTip === null ? '' : `${current.remoteTip}\trefs/heads/${remoteBranch}`)
    if (current.branch !== null && key === `push origin HEAD:refs/heads/${current.branch}`) {
      current = { ...current, remoteTip: current.head }
      return ok()
    }
    return undefined
  }
  const git: GitRunner = async (_cwd, args) => {
    const key = args.join(' ')
    const checkoutResult = checkoutObservation(key)
    if (checkoutResult !== undefined) return checkoutResult
    const observed = historyObservation(args, key)
    if (observed !== undefined) return observed
    const remote = remoteOperation(key)
    if (remote !== undefined) return remote
    throw new Error(`Undeclared Git observation ${key}`)
  }
  return { git, checkout }
}
