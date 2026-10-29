import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

function createCheckout() {
  const root = mkdtempSync(path.join(tmpdir(), 'omp-review-record-'))
  const bare = path.join(root, 'origin.git')
  const worktree = path.join(root, 'wt')
  git(root, ['init', '-q', '--bare', '-b', 'main', bare])
  git(root, ['init', '-q', '-b', 'main', worktree])
  writeFileSync(path.join(worktree, 'base.txt'), 'base\n')
  git(worktree, ['add', '.'])
  git(worktree, ['commit', '-qm', 'base'])
  const heads = [git(worktree, ['rev-parse', 'HEAD'])]
  git(worktree, ['remote', 'add', 'origin', 'https://github.com/acme/app.git'])
  git(worktree, ['config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git'])
  git(worktree, ['push', '-q', 'origin', 'HEAD:main'])
  for (const name of ['two', 'three', 'four']) {
    writeFileSync(path.join(worktree, `${name}.txt`), `${name}\n`)
    git(worktree, ['add', '.'])
    git(worktree, ['commit', '-qm', name])
    heads.push(git(worktree, ['rev-parse', 'HEAD']))
  }
  return { worktree, heads }
}

const checkout = createCheckout()
export const WORKTREE = checkout.worktree
export const CHECKOUT_HEADS = checkout.heads

function success(stdout = '') {
  return { code: 0, stdout, stderr: '' }
}

function remoteUrl(args) {
  return args[0] === 'remote' && args[1] === 'get-url' ? success('https://github.com/acme/app.git\n') : null
}

function worktreeRoot(args) {
  return args[0] === 'rev-parse' && args[1] === '--show-toplevel' ? success(`${WORKTREE}\n`) : null
}

function missingStackConfig(args) {
  return args[0] === 'show' && String(args[1]).endsWith(':.dev/stack.yml')
    ? { code: 128, stdout: '', stderr: 'fatal: path .dev/stack.yml does not exist' }
    : null
}

function revisionResult(args, state, heads) {
  if (args[0] !== 'rev-parse') return null
  if (args.includes('HEAD^{commit}')) return success(`${state.head}\n`)
  if (args.some((arg) => String(arg).includes(':'))) return { code: 1, stdout: '', stderr: 'absent' }
  return success(`${heads[0]}\n`)
}

function inputTreeReader(state, moveHeadAfterInputRead) {
  let reads = 0
  return (args) => {
    if (args[0] !== 'ls-tree') return null
    if (!args.includes('-r')) return success()
    reads += 1
    if (reads === 2 && moveHeadAfterInputRead !== null) state.head = moveHeadAfterInputRead
    return success()
  }
}

export function createGateGit({ state, moveHeadAfterInputRead, heads }) {
  const inputTreeRead = inputTreeReader(state, moveHeadAfterInputRead)
  return async (_cwd, args) => {
    const remote = remoteUrl(args)
    if (remote !== null) return remote
    const root = worktreeRoot(args)
    if (root !== null) return root
    const stack = missingStackConfig(args)
    if (stack !== null) return stack
    const revision = revisionResult(args, state, heads)
    if (revision !== null) return revision
    const tree = inputTreeRead(args)
    if (tree !== null) return tree
    return success()
  }
}
