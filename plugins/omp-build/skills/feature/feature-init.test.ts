import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { plan, readFacts } from './feature-init'

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function write(rel: string, body: string) {
  if (!root) throw new Error('fixture missing')
  const file = path.join(root, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
}

describe('feature init plan', () => {
  it('lists the metalyde adoption gaps', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-metalyde-'))
    write('.semctx/working/a/change.json', '{"status":"active"}\n')
    write('.semctx/working/b/change.json', '{"status":"active"}\n')
    write('.semctx/working/c/change.json', '{"status":"active"}\n')
    write('.semctx/working/d/change.json', '{"status":"active"}\n')
    write('.cocoindex_code/keep', '')
    write('.codegraph/keep', '')
    write('package.json', '{"devDependencies":{"vitest":"1"}}\n')
    write('.dev/stack.yml', 'release:\n  model: staging-train\n')
    write('.github/workflows/merge-on-green.yml', 'workflows: ["Secret scan", "Lint & Test"]\n/^ci$/\nhasSecret\n')
    write('.github/workflows/secret-scan.yml', 'name: Secret scan\n')
    const lines = plan(readFacts(root, ['XS', 'M', 'priority: high']))
    expect(lines).toContain('tracker contract')
    expect(lines).toContain('label migration')
    expect(lines).toContain('semctx hooks')
    expect(lines).toContain('CI job semctx-working-empty')
    expect(lines).toContain('4 orphan contracts')
    expect(lines).toContain('assertledger + vitest adapter')
    expect(lines).toContain('landing = merge-on-green with ci + Secret scan')
    expect(lines).toContain('worktree block')
    expect(lines).toContain('release.post_merge asked')
    expect(lines).not.toContain('codegraph proposed')
  })

  it('lists the boilerplate-cf adoption gaps', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-cf-'))
    write('.semctx/config.json', '{}\n')
    write('lefthook.yml', 'pre-commit:\n  commands:\n    semctx:\n      run: semctx verify\n')
    write('.github/workflows/ci.yml', 'semctx-working-empty:\n')
    write('.cocoindex_code/keep', '')
    write('package.json', '{"devDependencies":{"vitest":"1","assertledger":"1"}}\n')
    write('.dev/stack.yml', 'release:\n  component: kit\n')
    write(
      '.github/workflows/merge-on-green.yml',
      'workflows: [Secret scan, CI]\n/^ci$/\nsemctx-working-empty\nhasWorking\n',
    )
    write('.github/workflows/secret-scan.yml', 'jobs:\n  trufflehog:\n    name: TruffleHog\n')
    const lines = plan(readFacts(root, []))
    expect(lines).toContain('tracker contract')
    expect(lines).toContain('labels')
    expect(lines).toContain('landing = merge-on-green with ci + TruffleHog + semctx-working-empty')
    expect(lines).toContain('release.model asked')
    expect(lines).toContain('codegraph proposed')
    expect(lines).not.toContain('label migration')
    expect(lines).not.toContain('assertledger + vitest adapter')
  })
})
