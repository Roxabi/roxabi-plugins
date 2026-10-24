export const PROOF_PIN_PATHS = ['.semctx/config.json', 'assertledger.config.json', '.dev/stack.yml'] as const

const SHA = /^[0-9a-f]{40}$/

export type ProofConfigPin = { sourceCommit: string; path: string; blob: string | null }

export type GitRunner = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export async function readProofConfigPins(git: GitRunner, toplevel: string, commit: string): Promise<ProofConfigPin[]> {
  const resolved = await git(toplevel, ['rev-parse', '--verify', `${commit}^{commit}`])
  const sourceCommit = resolved.stdout.trim()
  if (resolved.code !== 0 || !SHA.test(sourceCommit)) {
    throw new Error(`proof pin source ${commit} is not a commit`)
  }
  const pins: ProofConfigPin[] = []
  for (const path of PROOF_PIN_PATHS) {
    const listed = await git(toplevel, ['rev-parse', '--verify', '--quiet', `${sourceCommit}:${path}`])
    const blob = listed.stdout.trim()
    pins.push({
      sourceCommit,
      path,
      blob: listed.code === 0 && SHA.test(blob) ? blob : null,
    })
  }
  return pins
}
