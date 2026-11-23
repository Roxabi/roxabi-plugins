import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { vi } from 'vitest'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { consultableAgentRoot, consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { INSTALL_ROOT } from '../install-root.ts'
import { type FeatureCommandComposition, runFeatureCommand } from '../omp-feature-command.ts'

export function featureCommandContext(cwd: string) {
  const root = consultableAgentRoot()
  const protocol = consultableProtocolOptions()
  return {
    ...root,
    cwd,
    localProtocolOptions: protocol,
    sessionManager: {
      ...root.sessionManager,
      getCwd: () => cwd,
      getSessionFile: () => join(protocol.getArtifactsDir(), 'session.jsonl'),
      getArtifactsDir: protocol.getArtifactsDir,
    },
  }
}

export function commandComposition(
  cwd: string,
  options: FeatureCommandComposition['options'],
  interruptOwnedFeatureWork: FeatureCommandComposition['interruptOwnedFeatureWork'] = async () => ({ failures: [] }),
) {
  const sent: string[] = []
  const framing = vi.fn<FeatureCommandComposition['framing']['start']>(async () => undefined)
  const pi = createExtensionApiStub({
    sendUserMessage: async (content) => {
      sent.push(String(content))
    },
    sendMessage: (message) => {
      sent.push(typeof message === 'string' ? message : String(message?.content ?? message))
    },
  })
  const ctx = featureCommandContext(cwd)
  return {
    sent,
    framing,
    run: (args: string) =>
      runFeatureCommand(args, ctx as never, {
        pi,
        options,
        installRoot: INSTALL_ROOT,
        skillsDir: join(INSTALL_ROOT, 'skills'),
        exists: existsSync,
        interruptOwnedFeatureWork,
        framing: { start: framing },
      }),
  }
}
