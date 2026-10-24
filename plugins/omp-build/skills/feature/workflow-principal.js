import { git } from './workflow-runtime.js'

const PRINCIPALS = ['staging', 'main', 'master']
const fetched = new Set()

export function pickPrincipal(present) {
  for (const branch of PRINCIPALS) if (present.has(branch)) return branch
  return null
}

async function refExists(cwd, ref) {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

async function fetchOrigin(cwd) {
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (fetched.has(root)) return
  await git(cwd, ['fetch', 'origin', '--prune'])
  fetched.add(root)
}

export async function detectPrincipal(cwd) {
  await fetchOrigin(cwd)
  const present = new Set()
  for (const branch of PRINCIPALS) {
    if ((await refExists(cwd, `refs/remotes/origin/${branch}`)) || (await refExists(cwd, `refs/heads/${branch}`))) {
      present.add(branch)
    }
  }
  const name = pickPrincipal(present)
  if (!name) throw new Error('no principal branch (staging|main|master)')
  return name
}
