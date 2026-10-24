import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dir, ROSTER, useRosterWorkspace } from './roster.fixture'

useRosterWorkspace()

describe('roster CLI', () => {
  it('CLI --chunk-list twice produces chunk_agents length 2', () => {
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/a.ts\nsrc/b.ts\n')
    const c0 = join(dir, 'c0.txt')
    const c1 = join(dir, 'c1.txt')
    writeFileSync(c0, 'src/a.ts\n')
    writeFileSync(c1, 'src/b.ts\n')
    const proc = spawnSync(
      'bun',
      [ROSTER, '--diff-list', delta, '--chunk-list', c0, '--chunk-list', c1, '--tier', 'F-full', '--json'],
      { encoding: 'utf8' },
    )
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as {
      chunk_agents: string[][]
      agents: string[]
      chunks: number
    }
    expect(json.chunk_agents).toHaveLength(2)
    expect(json.chunks).toBe(2)
  })

  it('two --chunk-list files without --chunks derive chunks=2', () => {
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/a.ts\nsrc/b.ts\n')
    const c0 = join(dir, 'c0.txt')
    const c1 = join(dir, 'c1.txt')
    writeFileSync(c0, 'src/a.ts\n')
    writeFileSync(c1, 'src/b.ts\n')
    const proc = spawnSync(
      'bun',
      [ROSTER, '--diff-list', delta, '--chunk-list', c0, '--chunk-list', c1, '--tier', 'F-full', '--json'],
      { encoding: 'utf8' },
    )
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as { chunks: number; chunk_agents: string[][] }
    expect(json.chunks).toBe(2)
    expect(json.chunk_agents).toHaveLength(2)
  })

  it('--chunks disagrees with --chunk-list count: warning + file count wins', () => {
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/a.ts\nsrc/b.ts\n')
    const c0 = join(dir, 'c0.txt')
    const c1 = join(dir, 'c1.txt')
    writeFileSync(c0, 'src/a.ts\n')
    writeFileSync(c1, 'src/b.ts\n')
    const proc = spawnSync(
      'bun',
      [
        ROSTER,
        '--diff-list',
        delta,
        '--chunk-list',
        c0,
        '--chunk-list',
        c1,
        '--chunks',
        '1',
        '--tier',
        'F-full',
        '--json',
      ],
      { encoding: 'utf8' },
    )
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as { chunks: number; warnings: string[] }
    expect(json.chunks).toBe(2)
    expect(json.warnings.some((w) => w.includes('disagrees'))).toBe(true)
    expect(json.warnings).toContain('--chunks 1 disagrees with 2 --chunk-list file(s); using 2')
  })

  it('empty --chunk-list file exits 1', () => {
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/a.ts\n')
    const empty = join(dir, 'empty.txt')
    writeFileSync(empty, '\n\n')
    const proc = spawnSync('bun', [ROSTER, '--diff-list', delta, '--chunk-list', empty, '--json'], {
      encoding: 'utf8',
    })
    expect(proc.status).toBe(1)
    expect(proc.stderr).toMatch(/empty --chunk-list/)
  })

  it('chunk path absent from --diff-list warns', () => {
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/a.ts\n')
    const c0 = join(dir, 'c0.txt')
    writeFileSync(c0, 'src/a.ts\nsrc/missing.ts\n')
    const proc = spawnSync('bun', [ROSTER, '--diff-list', delta, '--chunk-list', c0, '--tier', 'F-full', '--json'], {
      encoding: 'utf8',
    })
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as { warnings: string[] }
    expect(json.warnings).toContain('chunk path not in --diff-list: src/missing.ts')
  })

  it('path in two chunks warns duplicate chunk path', () => {
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/a.ts\n')
    const c0 = join(dir, 'c0.txt')
    const c1 = join(dir, 'c1.txt')
    writeFileSync(c0, 'src/a.ts\n')
    writeFileSync(c1, 'src/a.ts\n')
    const proc = spawnSync(
      'bun',
      [ROSTER, '--diff-list', delta, '--chunk-list', c0, '--chunk-list', c1, '--tier', 'F-full', '--json'],
      { encoding: 'utf8' },
    )
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as { warnings: string[] }
    expect(json.warnings).toContain('duplicate chunk path: src/a.ts')
  })

  // The reverse direction of the scope check: a Δ path in no chunk is reviewed by
  // nobody. Chunk→Δ alone left this undetected.
  it('delta path covered by no chunk warns', () => {
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/a.ts\nsrc/orphan.ts\n')
    const c0 = join(dir, 'c0.txt')
    writeFileSync(c0, 'src/a.ts\n')
    const proc = spawnSync('bun', [ROSTER, '--diff-list', delta, '--chunk-list', c0, '--tier', 'F-full', '--json'], {
      encoding: 'utf8',
    })
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as { warnings: string[] }
    expect(json.warnings).toContain('1 delta path(s) in no chunk: src/orphan.ts')
  })

  it('uncovered delta paths are aggregated, first 5 named', () => {
    const paths = Array.from({ length: 8 }, (_, i) => `src/orphan${i}.ts`)
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, `src/a.ts\n${paths.join('\n')}\n`)
    const c0 = join(dir, 'c0.txt')
    writeFileSync(c0, 'src/a.ts\n')
    const proc = spawnSync('bun', [ROSTER, '--diff-list', delta, '--chunk-list', c0, '--tier', 'F-full', '--json'], {
      encoding: 'utf8',
    })
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as { warnings: string[] }
    expect(json.warnings).toContain(`8 delta path(s) in no chunk: ${paths.slice(0, 5).join(', ')} (+3 more)`)
    expect(json.warnings.filter((w) => w.includes('in no chunk')).length).toBe(1)
  })
})
