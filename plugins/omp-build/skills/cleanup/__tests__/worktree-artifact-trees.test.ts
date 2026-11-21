import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountPointsWithin, parseMountPoints } from '../worktree-artifact-trees'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

afterEach(() => {
  vi.mocked(readFileSync).mockReset()
})

describe('mount table inspection', () => {
  it('decodes escaped mount point characters from kernel records', () => {
    const data = '42 1 8:1 / /tmp/a\\040b\\011c\\134d rw - ext4 /dev/test rw\n'
    expect(parseMountPoints(data)).toEqual(['/tmp/a b\tc\\d'])
  })

  it.each(['not a mount record', '42 1 8:1 / /tmp rw ext4 /dev/test rw', '42 1 8:1 / /tmp rw - ext4'])(
    'rejects malformed mountinfo: %s',
    (data) => {
      expect(() => parseMountPoints(data)).toThrow('malformed mountinfo')
    },
  )

  it.skipIf(process.platform !== 'linux')(
    'includes root, same-device bind and file mounts but excludes siblings',
    () => {
      const data = [
        '1 0 8:1 / / rw - ext4 /dev/test rw',
        '2 1 8:1 / /work/tree rw - ext4 /dev/test rw',
        '3 2 8:1 /source /work/tree/node_modules rw shared:17 master:3 - ext4 /dev/test rw',
        '4 2 8:1 /file /work/tree/config rw - ext4 /dev/test rw',
        '5 1 8:1 / /work/tree-sibling rw - ext4 /dev/test rw',
        '6 2 8:1 / /work/tree/a\\040b rw - ext4 /dev/test rw',
      ].join('\n')
      vi.mocked(readFileSync).mockReturnValueOnce(data as never)
      expect(mountPointsWithin('/work/tree')).toEqual([
        '/work/tree',
        '/work/tree/node_modules',
        '/work/tree/config',
        '/work/tree/a b',
      ])
      expect(readFileSync).toHaveBeenCalledWith('/proc/self/mountinfo', 'utf8')
    },
  )

  it.skipIf(process.platform !== 'linux')('propagates malformed kernel data and read failures', () => {
    vi.mocked(readFileSync).mockReturnValueOnce('invalid\n' as never)
    expect(() => mountPointsWithin('/work/tree')).toThrow('malformed mountinfo')
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error('fixture mount table unavailable')
    })
    expect(() => mountPointsWithin('/work/tree')).toThrow('fixture mount table unavailable')
  })

  it.skipIf(process.platform === 'linux')('fails closed when kernel mount inspection is unsupported', () => {
    expect(() => mountPointsWithin('/work/tree')).toThrow('unsupported')
    expect(readFileSync).not.toHaveBeenCalled()
  })
})
