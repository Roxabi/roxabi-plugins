import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Gh } from '../../../../adapters/github/types.ts'
import type { ActionInputs } from '../../../../engine/action-input-schema.ts'
import { prepareUwAction, replayUwActionInputs } from '../../../../roxabi/uw-action-inputs.ts'
import { createProductionActionPorts } from '../../../../roxabi/uw-input-readers.ts'
import { createInstalledUwOperations } from '../../../../roxabi/uw-installed-operations.ts'
import type { GitRunner } from '../../../../roxabi/workflow-checkout.ts'

export async function goalChildOperations(
  cwd: string,
  transport: Gh,
  gitPort: GitRunner,
  tooling: { cwd: string; commit: string },
  inputs: ActionInputs,
) {
  const installed = await createInstalledUwOperations({
    cwd,
    gh: transport,
    readAuthor: 'operator',
    operator: {
      async executeConfirmed() {
        throw new Error('No operator mutation in child implementation')
      },
    },
  })
  const { files: _files, ...plugin } = inputs.manifest.plugin
  const fileBytes = (file: string) =>
    new Uint8Array(execFileSync('git', ['-C', tooling.cwd, 'show', `${tooling.commit}:${file}`]))
  const production = createProductionActionPorts({ cwd, gh: transport, git: gitPort, readAuthor: 'operator' })
  const readPinnedFile: typeof production.readPinnedFile = async (ref) => {
    if (ref.repository !== plugin.repository || ref.commit !== plugin.commit || !ref.path.startsWith(`${plugin.root}/`))
      return production.readPinnedFile(ref)
    const bytes = fileBytes(ref.path)
    if (createHash('sha256').update(bytes).digest('hex') !== ref.digest)
      return {
        ok: false,
        diagnostics: [{ code: 'action-input-stale', message: `Pinned tooling bytes differ: ${ref.path}` }],
      }
    return { ok: true, value: bytes }
  }
  const ports = {
    ...production,
    plugin: {
      async resolveInstalledPluginPin() {
        return { ok: true as const, value: plugin }
      },
      async readInstalledFile(file: string) {
        return { ok: true as const, value: fileBytes(`${plugin.root}/${file}`) }
      },
    },
    readPinnedFile,
    async readPinnedFiles(refs: Parameters<NonNullable<typeof production.readPinnedFiles>>[0]) {
      const values: Uint8Array[] = []
      for (const ref of refs) {
        const read = await readPinnedFile(ref)
        if (!read.ok) return read
        values.push(read.value)
      }
      return { ok: true as const, value: values }
    },
  }
  return {
    ...installed,
    prepareAction: (
      request: Parameters<typeof installed.prepareAction>[0],
      projection?: Parameters<typeof installed.prepareAction>[1],
      review?: Parameters<typeof installed.prepareAction>[2],
    ) => prepareUwAction(request, ports, projection, review),
    replayActionInputs: (request: Parameters<typeof installed.replayActionInputs>[0]) =>
      replayUwActionInputs(request, ports),
  }
}
