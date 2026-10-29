import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NativeProofBashCall } from '../review-runtime/contracts.ts'
import { commandRunFromCapture } from '../review-runtime/criterion-grounding.ts'
import { unusableOwnedReplacement } from '../review-runtime/result-replacement.ts'

const SHA = '0123456789abcdef0123456789abcdef01234567'

function call(command: string, text: string, toolCallId = 'call-1'): NativeProofBashCall {
  return {
    toolCallId,
    input: { command },
    effectiveCwd: '/repo',
    exitCode: 0,
    result: { content: [{ type: 'text', text }] },
  }
}

describe('factual command capture', () => {
  const identity = { repository: 'Roxabi/roxabi-plugins', commit: SHA, tree: 'b'.repeat(40) }
  const context = { probeCwd: '/repo', start: null, end: null }

  it('keeps the SDK view without claiming completeness or inventing executed code', () => {
    const run = commandRunFromCapture(call('npm test', 'ok\n', 'test-call'), context)
    expect(run).toEqual({
      toolCallId: 'test-call',
      command: 'npm test',
      exitCode: 0,
      output: { kind: 'sdk-view', text: 'ok\n', source: 'native-tool-result', completeness: 'potentially-incomplete' },
      context,
    })
    expect(run).not.toHaveProperty('code')
  })

  it('keeps unequal probe samples as context and does not promote them to code', () => {
    const changed = { probeCwd: '/repo', start: identity, end: { ...identity, commit: 'c'.repeat(40) } }
    const run = commandRunFromCapture(call('pnpm test -- actual', 'ok\n'), changed)
    expect(run?.context).toEqual(changed)
    expect(run).not.toHaveProperty('code')
    expect(run?.command).toBe('pnpm test -- actual')
  })

  it('retains inline marker text with no metadata as a potentially incomplete SDK view', () => {
    const marker = `[raw output: artifact://9]\n${SHA}\n`
    expect(commandRunFromCapture(call('pnpm test', marker), context)?.output).toEqual({
      kind: 'sdk-view',
      text: marker,
      source: 'native-tool-result',
      completeness: 'potentially-incomplete',
    })
  })

  it('ignores a mutable forged artifact matching truncation metadata and retains inline event text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-forged-artifact-'))
    const artifact = join(dir, '4')
    try {
      writeFileSync(artifact, 'forged complete output\n')
      const truncated = call('pnpm test', 'inline preview\n')
      truncated.result = {
        content: [{ type: 'text', text: 'inline preview\n' }],
        details: { meta: { truncation: { artifactId: '4', artifactPath: artifact } } },
      }
      const expected = {
        kind: 'sdk-view',
        text: 'inline preview\n',
        source: 'native-tool-result',
        completeness: 'known-incomplete',
      }
      expect(commandRunFromCapture(truncated, context)?.output).toEqual(expected)
      writeFileSync(artifact, 'different forged output\n')
      expect(commandRunFromCapture(truncated, context)?.output).toEqual(expected)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('marks metadata column truncation as known incomplete without discarding the view', () => {
    const capped = call('pnpm test', 'full-looking\n')
    capped.result = {
      content: [{ type: 'text', text: 'full-looking\n' }],
      details: { meta: { limits: { columnTruncated: { maxColumn: 80, unit: 'bytes' } } } },
    }
    expect(commandRunFromCapture(capped, context)?.output).toEqual({
      kind: 'sdk-view',
      text: 'full-looking\n',
      source: 'native-tool-result',
      completeness: 'known-incomplete',
    })
  })

  it('keeps an unusable owned replacement compact and non-local', () => {
    const replacement = unusableOwnedReplacement('retention-failed')
    expect(replacement.isError).toBe(true)
    expect(replacement.details.detailRef).toBe('retention-unavailable')
    expect(replacement.details.replacedAutomaticPreview).toBe(true)
    expect(JSON.stringify(replacement)).not.toContain(SHA)
  })
})
