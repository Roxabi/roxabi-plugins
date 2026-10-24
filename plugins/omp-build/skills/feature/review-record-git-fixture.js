function success(stdout = '') {
  return { code: 0, stdout, stderr: '' }
}

function remoteUrl(args) {
  return args[0] === 'remote' && args[1] === 'get-url' ? success('https://github.com/acme/app.git\n') : null
}

function worktreeRoot(args) {
  return args[0] === 'rev-parse' && args[1] === '--show-toplevel' ? success('/tmp/wt\n') : null
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

function proofTreeReader(state, moveHeadAfterProofRead) {
  let reads = 0
  return (args) => {
    if (args[0] !== 'ls-tree') return null
    if (!args.includes('-r')) return success()
    reads += 1
    if (reads === 2 && moveHeadAfterProofRead !== null) state.head = moveHeadAfterProofRead
    return success()
  }
}

export function createGateGit({ state, moveHeadAfterProofRead, heads }) {
  const proofTreeRead = proofTreeReader(state, moveHeadAfterProofRead)
  return async (_cwd, args) => {
    const remote = remoteUrl(args)
    if (remote !== null) return remote
    const root = worktreeRoot(args)
    if (root !== null) return root
    const stack = missingStackConfig(args)
    if (stack !== null) return stack
    const revision = revisionResult(args, state, heads)
    if (revision !== null) return revision
    const tree = proofTreeRead(args)
    if (tree !== null) return tree
    return success()
  }
}
