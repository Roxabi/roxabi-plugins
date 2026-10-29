import { actionInputDigest, citesCurrentRootOutput, validateActionInputs } from '../engine/action-input.ts'
import { ACTION_BINDING_FORMAT, ACTION_INPUT_FORMAT, type ActionInputs } from '../engine/action-input-schema.ts'
import type { UwActionPorts, UwActionRequest } from '../roxabi/uw-action-contract.ts'
import { suppliedProcedurePaths } from '../roxabi/uw-action-dossier.ts'
import { sha256Bytes } from '../roxabi/uw-action-result.ts'

/** Same required plugin paths as buildManifest. Not a second pin authority. */
const REQUIRED_PLUGIN = [
  'package.json',
  'GLOSSARY.md',
  'skills/dev-review/review-classes.yml',
  'skills/dev-review/chunker.py',
  'skills/dev-review/digest.py',
  'skills/dev-review/prepare_context.py',
  'skills/dev-review/evidence-policy.md',
  'skills/dev-review/root-causes.md',
  'skills/dev-review/review-smells.md',
  'skills/dev-review/review-blind-spots.md',
] as const

function refused(diagnostics: readonly { message: string }[]): string {
  return diagnostics.map((item) => item.message).join('; ')
}

/** Current action inputs from the production ports. Digest matches currentActionFingerprint for the same request. */
export async function assembleActionInputs(request: UwActionRequest, ports: UwActionPorts): Promise<ActionInputs> {
  const pin = await ports.plugin.resolveInstalledPluginPin()
  if (!pin.ok) throw new Error(refused(pin.diagnostics))
  const facts = await ports.readCurrentActionFacts(request)
  if (!facts.ok) throw new Error(refused(facts.diagnostics))
  const references = await ports.repositoryReferences(request)
  if (!references.ok) throw new Error(refused(references.diagnostics))
  const pluginFiles = []
  for (const path of [...REQUIRED_PLUGIN, ...suppliedProcedurePaths(request.purpose)]) {
    const installed = await ports.plugin.readInstalledFile(path)
    if (!installed.ok) throw new Error(refused(installed.diagnostics))
    const digest = sha256Bytes(installed.value)
    const gitPath = `${pin.value.root}/${path}`
    const remote = await ports.readPinnedFile({
      source: 'git-file',
      repository: pin.value.repository,
      commit: pin.value.commit,
      path: gitPath,
      digest,
    })
    if (!remote.ok) throw new Error(refused(remote.diagnostics))
    if (Buffer.compare(Buffer.from(installed.value), Buffer.from(remote.value)) !== 0) {
      throw new Error(`Installed ${path} does not equal ${pin.value.repository}@${pin.value.commit}`)
    }
    pluginFiles.push({
      source: 'git-file' as const,
      repository: pin.value.repository,
      commit: pin.value.commit,
      path: gitPath,
      digest,
    })
  }
  const inputs: ActionInputs = {
    format: ACTION_BINDING_FORMAT,
    manifest: {
      format: ACTION_INPUT_FORMAT,
      purpose: request.purpose,
      subject: facts.value.subject,
      spec: facts.value.spec,
      code: request.code,
      acceptedSources: facts.value.acceptedSources,
      deliveryData: facts.value.deliveryData,
      repositoryReferences: references.value,
      plugin: { ...pin.value, files: pluginFiles },
      configuration: facts.value.configuration,
      expandedContext: [...request.expandedContext],
    },
    fingerprint: '',
    stageSources: [...request.stageSources],
  }
  inputs.fingerprint = actionInputDigest(inputs.manifest)
  const validated = validateActionInputs(inputs)
  if (!validated.ok) throw new Error(refused(validated.diagnostics))
  const cited = citesCurrentRootOutput(validated.value, facts.value.currentOutputs)
  if (cited.length > 0) throw new Error(refused(cited))
  return validated.value
}
