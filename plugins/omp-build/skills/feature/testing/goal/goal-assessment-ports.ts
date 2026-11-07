import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { MandateRecord } from '../../../../engine/workflow-control.ts'
import { prepareUwAction, replayUwActionInputs } from '../../../../roxabi/uw-action-inputs.ts'
import type { UwOperations } from '../../../../roxabi/uw-contract.ts'
import { createProductionActionPorts } from '../../../../roxabi/uw-input-readers.ts'
import type { GitRunner } from '../../../../roxabi/workflow-checkout.ts'
import { acceptedActionInputs } from '../../../../testing/action-input-fixtures.ts'
import { committedFixturePlugin } from '../../../../testing/committed-plugin-fixture.ts'
import { git, moduleGh, toolingFixture } from './goal-scenario-sandbox.ts'

export function assessmentPorts(cwd: string, operations: UwOperations, mandate: MandateRecord) {
  const transport = async (_cwd: string, args: string[]) => {
    const result = moduleGh(args)
    if (result.status !== 0) throw new Error(`Goal native read failed: ${result.stderr}`)
    return result.stdout
  }
  const gitPort: GitRunner = async (directory, args) => {
    try {
      return { code: 0, stdout: git(directory, args), stderr: '' }
    } catch (error) {
      return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
    }
  }
  const tooling = toolingFixture()
  const pinned = committedFixturePlugin(
    tooling.cwd,
    acceptedActionInputs(mandate, 'review').manifest.plugin,
    tooling.commit,
  )
  const { files: _files, ...plugin } = pinned
  const bytes = (file: string) =>
    new Uint8Array(execFileSync('git', ['-C', tooling.cwd, 'show', `${tooling.commit}:${file}`]))
  const production = createProductionActionPorts({ cwd, gh: transport, git: gitPort, readAuthor: 'operator' })
  const readPinnedFile: typeof production.readPinnedFile = async (ref) => {
    if (ref.repository !== plugin.repository || ref.commit !== plugin.commit || !ref.path.startsWith(`${plugin.root}/`))
      return production.readPinnedFile(ref)
    const value = bytes(ref.path)
    if (createHash('sha256').update(value).digest('hex') !== ref.digest)
      return {
        ok: false,
        diagnostics: [{ code: 'action-input-stale', message: `Pinned tooling bytes differ: ${ref.path}` }],
      }
    return { ok: true, value }
  }
  const ports = {
    ...production,
    plugin: {
      async resolveInstalledPluginPin() {
        return { ok: true as const, value: plugin }
      },
      async readInstalledFile(file: string) {
        return { ok: true as const, value: bytes(`${plugin.root}/${file}`) }
      },
    },
    readPinnedFile,
    async readPinnedFiles(refs: Parameters<NonNullable<typeof production.readPinnedFiles>>[0]) {
      const values: Uint8Array[] = []
      for (const ref of refs) {
        const result = await readPinnedFile(ref)
        if (!result.ok) return result
        values.push(result.value)
      }
      return { ok: true as const, value: values }
    },
  }
  const installed: UwOperations = {
    ...operations,
    prepareAction: (request, projection, review) => prepareUwAction(request, ports, projection, review),
    replayActionInputs: (request) => replayUwActionInputs(request, ports),
  }
  return { installed, transport, gitPort }
}
