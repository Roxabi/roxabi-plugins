import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { FRAMING_PROCEDURE_FILES } from '../plugins/omp-build/engine/framing-context-schema.ts'

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
  // The extension's runtime imports the vendored Kit core from the installed
  // plugin, not from the producing checkout. Keep its license beside it.
  for (const path of [
    'vendor/kit-head-authorization/index.cjs',
    'vendor/kit-head-authorization/LICENSE',
    'skills/feature/head-authorization.cjs',
    'skills/feature/head-authorization-reader.cjs',
    'skills/feature/head-authorization-cli.js',
    'skills/feature/trusted-bun.sh',
    'skills/feature/trusted-bunfig.toml',
    ...Object.values(FRAMING_PROCEDURE_FILES),
    'skills/feature/trusted-tsconfig.json',
  ]) {
    const entry = join(destination, path)
    if (!existsSync(entry) || !lstatSync(entry).isFile())
      throw new Error(`clean extension missing required distribution file: ${path}`)
  }
  // OMP loads extensions through its SDK graph loader, which supplies host
  // package imports even when the installed plugin has no node_modules.
  // Resolve the loader from B's frozen installation, not from the plugin.
  const smoke = `
    import { readFileSync } from 'node:fs'
    import { join } from 'node:path'
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
    const procedures = await loadLegacyPiModule(${JSON.stringify(join(destination, 'roxabi/feature-framing-procedures.ts'))})
    const version = JSON.parse(readFileSync(join(${JSON.stringify(destination)}, 'package.json'), 'utf8')).version
    const pin = { name: 'omp-build', version, repository: 'Roxabi/roxabi-plugins', commit: '0'.repeat(40), root: 'plugins/omp-build' }
    let changed = false
    const plugin = {
      resolveInstalledPluginPin: async () => ({ ok: true, value: pin }),
      readInstalledFile: async (path) => ({ ok: true, value: changed ? new Uint8Array([0]) : readFileSync(join(${JSON.stringify(destination)}, path)) }),
    }
    const ports = {
      plugin,
      readPinnedFile: async (ref) => ({ ok: true, value: readFileSync(join(${JSON.stringify(checkout)}, ref.path)) }),
    }
    const bundle = await procedures.loadFramingProcedures(ports)
    if (!bundle.ok || !(await procedures.verifyFramingProcedures(bundle.value)).ok) throw new Error('framing bundle failed verification')
    for (const stage of ['grilling', 'domain-modeling', 'codebase-design']) {
      if (!procedures.framingProcedureText(bundle.value, stage)) throw new Error('framing procedure unavailable: ' + stage)
    }
    const projection = await loadLegacyPiModule(${JSON.stringify(join(destination, 'omp/omp-feature-framing-context.ts'))})
    const original = { role: 'user', content: 'source', timestamp: 1 }
    const projected = await projection.projectFramingContext({ event: { messages: [original] }, procedures: bundle.value, stage: 'grilling', supplyToken: 'token', indexRef: 'index' })
    if (!projected.ok || projected.value.messages.length !== 2 || projected.value.messages[0] !== original || !projected.value.messages[1].content.includes(procedures.framingProcedureText(bundle.value, 'grilling'))) throw new Error('framing context projection failed')
    changed = true
    const drifted = await projection.projectFramingContext({ event: { messages: [original] }, procedures: bundle.value, stage: 'grilling', supplyToken: 'token', indexRef: 'index' })
    if (drifted.ok) throw new Error('changed installed procedure accepted')
    changed = false
    const corrupted = await procedures.loadFramingProcedures({ ...ports, readPinnedFile: async () => ({ ok: true, value: new Uint8Array([0]) }) })
    if (corrupted.ok) throw new Error('corrupt pinned procedure accepted')
    const missing = await procedures.loadFramingProcedures({ ...ports, plugin: { ...plugin, readInstalledFile: async () => ({ ok: false, diagnostics: [{ code: 'missing', message: 'missing installed procedure' }] }) } })
    if (missing.ok) throw new Error('missing installed procedure accepted')
    const malformedBytes = new TextEncoder().encode('# headings only')
    const malformed = await procedures.loadFramingProcedures({ plugin: { ...plugin, readInstalledFile: async () => ({ ok: true, value: malformedBytes }) }, readPinnedFile: async () => ({ ok: true, value: malformedBytes }) })
    if (malformed.ok) throw new Error('non-actionable procedure accepted')
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
