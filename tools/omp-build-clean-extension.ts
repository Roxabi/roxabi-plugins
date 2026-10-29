import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export function verifyCleanExtension(checkout: string, owned: string): void {
  for (let directory = realpathSync(owned); ; directory = dirname(directory)) {
    if (existsSync(join(directory, 'node_modules')))
      throw new Error(`clean extension import has ambient dependencies: ${join(directory, 'node_modules')}`)
    if (directory === dirname(directory)) break
  }
  const destination = join(owned, 'clean-plugin')
  cpSync(join(checkout, 'plugins/omp-build'), destination, {
    recursive: true,
    filter(path) {
      if (basename(path) === 'node_modules') return false
      if (lstatSync(path).isSymbolicLink()) throw new Error(`clean extension contains a symlink: ${path}`)
      return true
    },
  })
  // OMP loads extensions through its SDK graph loader, which supplies host
  // package imports even when the installed plugin has no node_modules.
  // Resolve the loader from B's frozen installation, not from the plugin.
  const smoke = `
    import { installLegacyPiSpecifierShim, loadLegacyPiModule } from '@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat'
    installLegacyPiSpecifierShim()
    const extension = await loadLegacyPiModule(${JSON.stringify(join(destination, 'omp/index.ts'))})
    if (typeof extension?.default !== 'function') throw new Error('extension has no default factory')
    // Exercise the computed lazy imports as well as the root extension graph.
    // Loading these modules must not execute any workflow or host action.
    const loader = await loadLegacyPiModule(${JSON.stringify(join(destination, 'roxabi/feature-loader.ts'))})
    if (typeof loader?.loadFeatureWorkflow !== 'function') throw new Error('missing loadFeatureWorkflow')
    const workflow = await loader.loadFeatureWorkflow()
    for (const name of ['continueFeature', 'requestFeatureSessionPause', 'publishFeatureNativeResult', 'consumeWatchExit']) {
      if (typeof workflow[name] !== 'function') throw new Error('missing feature module function: ' + name)
    }
  `
  try {
    execFileSync(process.execPath, ['--no-install', '--eval', smoke], {
      cwd: checkout,
      env: { PATH: process.env.PATH, HOME: owned, TMPDIR: owned, BUN_INSTALL_CACHE_DIR: join(owned, 'cache') },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const result = error as { stderr?: string; message?: string }
    throw new Error(`clean installed extension import failed: ${(result.stderr ?? result.message ?? '').trim()}`)
  }
  // Invoke the distributed CLI itself without arguments: its usage refusal
  // exercises the complete static import graph without reaching GitHub.
  const gate = spawnSync(process.execPath, ['--no-install', join(destination, 'scripts/review-gate.ts')], {
    cwd: owned,
    env: { PATH: process.env.PATH, HOME: owned, TMPDIR: owned, BUN_INSTALL_CACHE_DIR: join(owned, 'cache') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let result: unknown
  try {
    result = JSON.parse(gate.stdout)
  } catch {
    throw new Error(`clean review gate returned invalid JSON: ${gate.error?.message ?? gate.stderr}`)
  }
  if (
    gate.status !== 1 ||
    typeof result !== 'object' ||
    result === null ||
    (result as Record<string, unknown>).ok !== false ||
    (result as Record<string, unknown>).allowed !== false ||
    (result as Record<string, unknown>).reason !== 'unreadable'
  )
    throw new Error(
      `clean review gate did not return its usage refusal: status=${gate.status} stdout=${gate.stdout} stderr=${gate.stderr}`,
    )
}
