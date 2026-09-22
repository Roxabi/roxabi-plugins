import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const toolsDir = join(import.meta.dirname, '..')
const fileLength = join(toolsDir, 'check_file_length.sh')
const folderSize = join(toolsDir, 'check_folder_size.sh')
const licensePy = join(toolsDir, 'license_check.py')
const licenseTs = join(toolsDir, 'licenseChecker.ts')

const ISOLATED = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'QG_FILE_MAX',
  'QG_FILE_ROOT',
  'QG_FILE_METRIC',
  'QG_FILE_EXTS',
  'QG_FILE_COUNTER',
  'QG_FILE_EXEMPTIONS',
  'QG_FILE_LENGTH_DISABLE',
  'QG_FOLDER_MAX',
  'QG_FOLDER_ROOT',
  'QG_FOLDER_EXEMPTIONS',
  'QG_FOLDER_SIZE_DISABLE',
  'QG_LICENSE_ROOT',
]

function isolatedEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of Object.keys(env)) {
    if (ISOLATED.includes(key) || key.startsWith('GIT_CONFIG') || key.startsWith('LEFTHOOK')) {
      delete env[key]
    }
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) env[key] = value
  }
  env.LEFTHOOK = '0'
  return env
}

function initRepo(dir: string) {
  const env = isolatedEnv()
  const git = (args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  }
  git(['init', '-q'])
}

function run(cmd: string, args: string[], cwd: string, extra?: NodeJS.ProcessEnv) {
  const r = spawnSync(cmd, args, { cwd, env: isolatedEnv(extra), encoding: 'utf8' })
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('check_file_length.sh', () => {
  let tmp: string

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  function repo() {
    tmp = mkdtempSync(join(tmpdir(), 'qg-file-'))
    initRepo(tmp)
    return tmp
  }

  it('passes a tree under the cap', () => {
    const dir = repo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'ok.py'), 'x\n')
    const r = run('bash', [fileLength], dir, { QG_FILE_MAX: '3' })
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('fails a file over the cap', () => {
    const dir = repo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'over.py'), 'a\nb\nc\nd\n')
    const r = run('bash', [fileLength], dir, { QG_FILE_MAX: '3' })
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('over.py')
  })

  it('fails closed when the scan root is missing', () => {
    const dir = repo()
    const r = run('bash', [fileLength], dir)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("expected directory 'src/' not found")
    expect(r.stderr).toContain('QG_FILE_LENGTH_DISABLE')
    expect(r.stderr).toContain('QG_FILE_ROOT')
  })

  it('stays silent when the operator opts out', () => {
    const dir = repo()
    const r = run('bash', [fileLength], dir, { QG_FILE_LENGTH_DISABLE: '1' })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })

  it('accepts true and yes, and rejects an empty opt-out', () => {
    const dir = repo()
    expect(run('bash', [fileLength], dir, { QG_FILE_LENGTH_DISABLE: 'yes' }).code).toBe(0)
    expect(run('bash', [fileLength], dir, { QG_FILE_LENGTH_DISABLE: 'TRUE' }).code).toBe(0)
    const empty = run('bash', [fileLength], dir, { QG_FILE_LENGTH_DISABLE: '' })
    expect(empty.code).toBe(1)
    expect(empty.stderr).toContain('QG_FILE_LENGTH_DISABLE')
  })

  it('honours an explicit opt-out in tools/qg.conf', () => {
    const dir = repo()
    mkdirSync(join(dir, 'tools'))
    writeFileSync(join(dir, 'tools', 'qg.conf'), ': "' + '$' + '{QG_FILE_LENGTH_DISABLE:=1}"\n')
    const r = run('bash', [fileLength], dir)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('lets a non-empty export beat qg.conf := assignment', () => {
    const dir = repo()
    mkdirSync(join(dir, 'tools'))
    writeFileSync(join(dir, 'tools', 'qg.conf'), ': "' + '$' + '{QG_FILE_LENGTH_DISABLE:=1}"\n')
    const r = run('bash', [fileLength], dir, { QG_FILE_LENGTH_DISABLE: '0' })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("expected directory 'src/' not found")
  })

  it('--self-test exits 0 without touching the work tree', () => {
    const dir = repo()
    const marker = join(dir, 'untouched')
    writeFileSync(marker, 'keep\n')
    const r = run('bash', [fileLength, '--self-test'], dir)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })
})

describe('check_folder_size.sh', () => {
  let tmp: string

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  function repo() {
    tmp = mkdtempSync(join(tmpdir(), 'qg-folder-'))
    initRepo(tmp)
    return tmp
  }

  it('passes a folder under the cap', () => {
    const dir = repo()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.py'), 'x\n')
    const r = run('bash', [folderSize], dir, { QG_FOLDER_MAX: '2' })
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('fails a folder over the cap', () => {
    const dir = repo()
    mkdirSync(join(dir, 'src'))
    for (const name of ['a.py', 'b.py', 'c.py']) writeFileSync(join(dir, 'src', name), 'x\n')
    const r = run('bash', [folderSize], dir, { QG_FOLDER_MAX: '2' })
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('src')
  })

  it('fails closed when the scan root is missing', () => {
    const dir = repo()
    const r = run('bash', [folderSize], dir)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("expected directory 'src/' not found")
    expect(r.stderr).toContain('QG_FOLDER_SIZE_DISABLE')
    expect(r.stderr).toContain('QG_FOLDER_ROOT')
  })

  it('stays silent when the operator opts out', () => {
    const dir = repo()
    const r = run('bash', [folderSize], dir, { QG_FOLDER_SIZE_DISABLE: '1' })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })

  it('honours an explicit opt-out in tools/qg.conf', () => {
    const dir = repo()
    mkdirSync(join(dir, 'tools'))
    writeFileSync(join(dir, 'tools', 'qg.conf'), ': "' + '$' + '{QG_FOLDER_SIZE_DISABLE:=1}"\n')
    expect(run('bash', [folderSize], dir).code).toBe(0)
  })

  it('--self-test exits 0', () => {
    const dir = repo()
    expect(run('bash', [folderSize, '--self-test'], dir).code).toBe(0)
  })
})

describe('license gate --self-test', () => {
  it('license_check.py --self-test exits 0', () => {
    const r = run('python3', [licensePy, '--self-test'], toolsDir)
    expect(r.code).toBe(0)
  })

  it('licenseChecker.ts --self-test exits 0', () => {
    const r = run('bun', [licenseTs, '--self-test'], toolsDir)
    expect(r.code).toBe(0)
  })
})
