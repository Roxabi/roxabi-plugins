import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Gh } from '../adapters/github/types.ts'
import type { ActionInputManifest, PinnedFileRef } from '../engine/action-input-schema.ts'
import { createProductionActionPorts } from '../roxabi/uw-input-readers.ts'
import type { GitRunner } from '../roxabi/workflow-checkout.ts'

/** Production readers with caller-declared checkout, diff and committed fixture bytes. */
export function nativeActionFixturePorts(input: {
  cwd: string
  artifactsDir: string
  gh: Gh
  git: GitRunner
  author: string
  plugin: ActionInputManifest['plugin']
  commits: ReadonlyMap<string, unknown>
  diffs: ReadonlyMap<string, Uint8Array>
  repositoryFiles: ReadonlyMap<string, { ref: PinnedFileRef; bytes: Uint8Array }>
}) {
  const { files: _files, ...pin } = input.plugin
  const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
  const pluginBytes = (path: string) => new Uint8Array(readFileSync(join(pluginRoot, path)))
  const production = createProductionActionPorts({
    cwd: input.cwd,
    gh: input.gh,
    git: input.git,
    readAuthor: input.author,
    artifactsDir: input.artifactsDir,
  })
  const bytesFor = (ref: PinnedFileRef) => {
    const file = input.repositoryFiles.get(`${ref.repository}\0${ref.commit}\0${ref.path}`)
    if (file && file.ref.digest === ref.digest) return file.bytes
    const prefix = `${pin.root}/`
    if (!ref.path.startsWith(prefix)) throw new Error(`Undeclared pinned file ${ref.path}`)
    return pluginBytes(ref.path.slice(prefix.length))
  }
  return {
    ...production,
    plugin: {
      async resolveInstalledPluginPin() {
        return { ok: true as const, value: pin }
      },
      async readInstalledFile(path: string) {
        return { ok: true as const, value: pluginBytes(path) }
      },
    },
    async readPinnedFile(ref: PinnedFileRef) {
      return { ok: true as const, value: bytesFor(ref) }
    },
    async readPinnedFiles(refs: readonly PinnedFileRef[]) {
      return { ok: true as const, value: refs.map(bytesFor) }
    },
    async readCodeDiff(code: { base: string; head: string }) {
      if (!input.commits.has(code.base) || !input.commits.has(code.head))
        throw new Error('Undeclared action code diff endpoints')
      if (code.base === code.head) return { ok: true as const, value: new Uint8Array() }
      const bytes = input.diffs.get(`${code.base}\0${code.head}`)
      if (!bytes) throw new Error('Undeclared action code diff')
      return { ok: true as const, value: bytes }
    },
    async repositoryReferences() {
      return { ok: true as const, value: [...input.repositoryFiles.values()].map(({ ref }) => ref) }
    },
  }
}
