import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'

/**
 * Vitest unit tests only. Standalone Bun drivers must not import this module.
 * The directory is deleted when the calling test finishes.
 */
export function consultableProtocolOptions(): { getArtifactsDir(): string } {
  const artifacts = mkdtempSync(join(tmpdir(), 'omp-protocol-'))
  onTestFinished(() => {
    rmSync(artifacts, { recursive: true, force: true })
  })
  return { getArtifactsDir: () => artifacts }
}

/** Main-agent context whose artifact dir is deleted when the calling unit test finishes. */
export function consultableAgentRoot(): {
  agent: { kind: 'main'; id: 'Main'; name: 'main'; depth: 0 }
  localProtocolOptions: { getArtifactsDir(): string }
} {
  return {
    agent: { kind: 'main', id: 'Main', name: 'main', depth: 0 },
    localProtocolOptions: { getArtifactsDir: () => consultableProtocolOptions().getArtifactsDir() },
  }
}
