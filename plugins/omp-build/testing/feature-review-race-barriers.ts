import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs'
import path from 'node:path'

function waitFor(file: string, timeout = 10_000): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let settled = false
  let watcher!: ReturnType<typeof watch>
  let timer!: ReturnType<typeof setTimeout>
  const done = (error?: Error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    watcher.close()
    if (error === undefined) resolve()
    else reject(error)
  }
  watcher = watch(path.dirname(file), (_event, name) => {
    if (name === path.basename(file) && existsSync(file)) done()
  })
  timer = setTimeout(() => done(new Error(`git barrier timeout: ${file}`)), timeout)
  if (existsSync(file)) done()
  return promise
}
export type GitBarrier = { started: Promise<void>; release(): void; close(): void }

export function gitBarrier(markerTimeout = 10_000): GitBarrier {
  const state = process.env.GH_SIM_STATE
  if (state === undefined) throw new Error('gh-state-missing')
  const root = mkdtempSync(path.join(path.dirname(state), 'omp-race-git-'))
  const started = path.join(root, 'started')
  const release = path.join(root, 'release')
  const once = path.join(root, 'once')
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const script = `#!/bin/sh\nif [ "$1" = ls-remote ] && [ "$2" = --refs ] && mkdir "$OMP_RACE_GIT_ONCE" 2>/dev/null; then : > "$OMP_RACE_GIT_STARTED"; deadline=$(( $(date +%s) + 20 )); while [ ! -f "$OMP_RACE_GIT_RELEASE" ]; do [ "$(date +%s)" -lt "$deadline" ] || exit 124; sleep 0.01; done; fi\nexec "$OMP_RACE_REAL_GIT" "$@"\n`
  writeFileSync(path.join(root, 'git'), script)
  chmodSync(path.join(root, 'git'), 0o755)
  const before = process.env.PATH
  Object.assign(process.env, {
    PATH: `${root}:${before}`,
    OMP_RACE_GIT_STARTED: started,
    OMP_RACE_GIT_RELEASE: release,
    OMP_RACE_GIT_ONCE: once,
    OMP_RACE_REAL_GIT: real,
  })
  return {
    started: waitFor(started, markerTimeout),
    release: () => writeFileSync(release, 'release\n'),
    close: () => {
      if (before === undefined) delete process.env.PATH
      else process.env.PATH = before
      delete process.env.OMP_RACE_GIT_STARTED
      delete process.env.OMP_RACE_GIT_RELEASE
      delete process.env.OMP_RACE_GIT_ONCE
      delete process.env.OMP_RACE_REAL_GIT
      rmSync(root, { recursive: true, force: true })
    },
  }
}
export function failNextPost(hold = false) {
  const state = process.env.GH_SIM_STATE
  if (state === undefined) throw new Error('gh-state-missing')
  const root = mkdtempSync(path.join(path.dirname(state), 'omp-race-gh-'))
  const premature = path.join(root, 'operator-control-post-before-checkout-release')
  const failed = path.join(root, 'operator-control-post-refused')
  const real = execFileSync('which', ['gh'], { encoding: 'utf8' }).trim()
  const script = `#!/bin/sh\nif [ "$1" = api ]; then case " $* " in *" --method POST "*"kind=operator-control "*) [ -f "$OMP_RACE_GIT_RELEASE" ] || : > "$OMP_RACE_POST_PREMATURE"; : > "$OMP_RACE_POST_REFUSED"; ${hold ? 'deadline=$(( $(date +%s) + 20 )); while [ ! -f "$OMP_RACE_POST_RELEASE" ]; do [ "$(date +%s)" -lt "$deadline" ] || exit 124; sleep 0.01; done' : 'echo gh-race-post-refused >&2; exit 1'};; esac; fi\nexec "$OMP_RACE_REAL_GH" "$@"\n`
  writeFileSync(path.join(root, 'gh'), script)
  chmodSync(path.join(root, 'gh'), 0o755)
  const before = process.env.PATH
  process.env.PATH = `${root}:${before}`
  process.env.OMP_RACE_REAL_GH = real
  process.env.OMP_RACE_POST_REFUSED = failed
  process.env.OMP_RACE_POST_PREMATURE = premature
  process.env.OMP_RACE_POST_RELEASE = path.join(root, 'release')
  return {
    failed: () => existsSync(failed),
    premature: () => existsSync(premature),
    refused: waitFor(failed),
    release: () => writeFileSync(path.join(root, 'release'), 'release\n'),
    close: () => {
      if (before === undefined) delete process.env.PATH
      else process.env.PATH = before
      delete process.env.OMP_RACE_REAL_GH
      delete process.env.OMP_RACE_POST_REFUSED
      delete process.env.OMP_RACE_POST_PREMATURE
      delete process.env.OMP_RACE_POST_RELEASE
      rmSync(root, { recursive: true, force: true })
    },
  }
}
