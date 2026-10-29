import { existsSync, rmSync, writeFileSync } from 'node:fs'

export async function waitForBarrier(ready: () => boolean, completion: Promise<unknown>): Promise<void> {
  let completionSettled = false
  void completion.then(
    () => {
      completionSettled = true
    },
    () => {
      completionSettled = true
    },
  )
  while (!ready()) {
    if (completionSettled) throw new Error('authorize-push-barrier-unreached')
    const timer = Promise.withResolvers<void>()
    setTimeout(timer.resolve, 5)
    await timer.promise
  }
}

export async function releaseLiveInterleaveBarrier(
  release: string,
  completing: Promise<void> | null,
  originalPath: string | undefined,
  gate: string,
): Promise<void> {
  if (!existsSync(release)) writeFileSync(release, '')
  if (completing !== null) {
    try {
      await completing
    } catch {
      // Preserve the original failure while allowing the released Git wrapper to exit.
    }
  }
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  delete process.env.OMP_BUILD_AUTHORIZE_READY
  delete process.env.OMP_BUILD_AUTHORIZE_RELEASE
  delete process.env.OMP_BUILD_PUSHED
  delete process.env.OMP_BUILD_REAL_GIT
  rmSync(gate, { recursive: true, force: true })
}
