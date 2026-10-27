import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readNativeIssueStateText } from './issue-state.ts'

const number = process.argv[2]
if (number === undefined) throw new Error('issue number required')
const run = promisify(execFile)
const state = await readNativeIssueStateText(
  process.cwd(),
  async (cwd, args) => {
    const { stdout } = await run('gh', args, { cwd, encoding: 'utf8' })
    return String(stdout)
  },
  number,
)
process.stdout.write(state)
