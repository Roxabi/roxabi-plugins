import { canonicalValueDigest, FRAMING_PROCEDURE_FILES } from '../dist/contracts.js'
import type { FramingProcedureManifest, FramingStage } from '../engine/framing-context-schema.ts'
import type { Result } from '../engine/result.ts'
import type { PinnedFileRef, PluginPinPort } from './uw-action-contract.ts'
import { actionFailure, sha256Bytes } from './uw-action-result.ts'

type ProcedurePorts = {
  plugin: PluginPinPort
  readPinnedFile(ref: PinnedFileRef): Promise<Result<Uint8Array>>
}
export type FramingProcedures = Readonly<{ manifest: FramingProcedureManifest }>
type Registered = { texts: Readonly<Record<FramingStage, string>>; ports: ProcedurePorts }
const registered = new WeakMap<FramingProcedures, Registered>()
const stages = ['grilling', 'domain-modeling', 'codebase-design'] as const

type PinnedProcedure = { ref: PinnedFileRef; text: string }

/** Installed bytes must equal the trusted pinned bytes and form an actionable UTF-8 procedure. */
async function readPinnedProcedure(
  ports: ProcedurePorts,
  pin: Readonly<{ repository: string; commit: string; root: string }>,
  path: string,
): Promise<Result<PinnedProcedure>> {
  const installed = await ports.plugin.readInstalledFile(path)
  if (!installed.ok) return installed
  const ref: PinnedFileRef = {
    source: 'git-file',
    repository: pin.repository,
    commit: pin.commit,
    path: `${pin.root}/${path}`,
    digest: sha256Bytes(installed.value),
  }
  const pinned = await ports.readPinnedFile(ref)
  if (!pinned.ok) return pinned
  if (sha256Bytes(pinned.value) !== ref.digest || !Buffer.from(installed.value).equals(Buffer.from(pinned.value)))
    return actionFailure('plugin-pin-mismatch', `Framing procedure differs from pinned bytes: ${path}`)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(installed.value)
  } catch {
    return actionFailure('plugin-pin-mismatch', `Framing procedure is not UTF-8: ${path}`)
  }
  if (!/^## Steps\s*$/m.test(text) || !/^## Done\s*$/m.test(text) || !/^\d+\.\s+\S/m.test(text))
    return actionFailure('plugin-pin-mismatch', `Framing procedure is not actionable: ${path}`)
  return { ok: true, value: { ref, text } }
}

/** A bundle is usable only through its registered host object, never a JSON clone. */
export async function loadFramingProcedures(ports: ProcedurePorts): Promise<Result<FramingProcedures>> {
  const pinResult = await ports.plugin.resolveInstalledPluginPin()
  if (!pinResult.ok) return pinResult
  const pin = pinResult.value
  const files: PinnedFileRef[] = []
  const texts: string[] = []
  for (const stage of stages) {
    const procedure = await readPinnedProcedure(ports, pin, FRAMING_PROCEDURE_FILES[stage])
    if (!procedure.ok) return procedure
    files.push(procedure.value.ref)
    texts.push(procedure.value.text)
  }
  const [grilling, domain, design] = files
  const [grillingText, domainText, designText] = texts
  if (!grilling || !domain || !design || !grillingText || !domainText || !designText)
    return actionFailure('plugin-pin-mismatch', 'Incomplete framing procedure bundle')
  const payload = {
    format: 'omp-build-framing-procedures/1' as const,
    plugin: { ...pin, files },
    procedures: [
      { stage: 'grilling' as const, file: grilling },
      { stage: 'domain-modeling' as const, file: domain },
      { stage: 'codebase-design' as const, file: design },
    ] satisfies FramingProcedureManifest['procedures'],
  }
  const manifest = { ...payload, digest: canonicalValueDigest(payload) }
  const handle: FramingProcedures = Object.freeze({ manifest })
  Object.freeze(files)
  for (const file of files) Object.freeze(file)
  Object.freeze(manifest.plugin)
  for (const procedure of manifest.procedures) Object.freeze(procedure)
  Object.freeze(manifest.procedures)
  Object.freeze(manifest)
  registered.set(handle, {
    texts: Object.freeze({ grilling: grillingText, 'domain-modeling': domainText, 'codebase-design': designText }),
    ports,
  })
  return { ok: true, value: handle }
}

/** Recheck both the installed bytes and their trusted pinned source on every use. */
export async function verifyFramingProcedures(handle: FramingProcedures): Promise<Result<true>> {
  const entry = registered.get(handle)
  if (!entry) return actionFailure('plugin-pin-mismatch', 'Unregistered framing procedure bundle')
  const pin = await entry.ports.plugin.resolveInstalledPluginPin()
  if (!pin.ok) return pin
  const { files: _files, ...expected } = handle.manifest.plugin
  if (canonicalValueDigest(pin.value) !== canonicalValueDigest(expected))
    return actionFailure('plugin-pin-mismatch', 'Framing plugin identity changed')
  for (const procedure of handle.manifest.procedures) {
    const bytes = await entry.ports.plugin.readInstalledFile(FRAMING_PROCEDURE_FILES[procedure.stage])
    if (!bytes.ok) return bytes
    const pinned = await entry.ports.readPinnedFile(procedure.file)
    if (!pinned.ok) return pinned
    if (
      sha256Bytes(pinned.value) !== procedure.file.digest ||
      !Buffer.from(bytes.value).equals(Buffer.from(pinned.value))
    )
      return actionFailure('plugin-pin-mismatch', 'Pinned framing procedure bytes changed')
    if (sha256Bytes(bytes.value) !== procedure.file.digest)
      return actionFailure('plugin-pin-mismatch', 'Framing procedure bytes changed')
  }
  return { ok: true, value: true }
}

export function framingProcedureText(handle: FramingProcedures, stage: FramingStage): string | undefined {
  return registered.get(handle)?.texts[stage]
}
