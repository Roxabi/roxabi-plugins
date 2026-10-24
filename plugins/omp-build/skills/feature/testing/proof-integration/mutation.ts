import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SIM } from '../../__fixtures__/proof/sandbox-repository'
import type { Box } from '../../__fixtures__/proof/sandbox-types'
import { REAL_BUN } from './environment'

/** Change an external input after gh has read it, while the real caller awaits its reply. */
export function mutateAfter(
  box: Box,
  when:
    | 'body-read'
    | 'label-write'
    | 'admission-comments'
    | 'classification-read'
    | 'pin-write'
    | 'disable-write'
    | 'remove-label-write'
    | 'base-read'
    | 'acquisition-comments'
    | 'repository-read'
    | 'admission-base-read'
    | 'comment-write',
  change: string,
  failClear?: '--disable-auto' | '--remove-label',
): () => void {
  const dir = mkdtempSync(path.join(box.root, 'gh-move-'))
  const originalPath = box.env.PATH
  const once = path.join(dir, 'changed')
  const shim = path.join(dir, 'gh')
  writeFileSync(
    shim,
    `#!${REAL_BUN}
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (${JSON.stringify(failClear ?? '')} && args.includes(${JSON.stringify(failClear ?? '')}) && existsSync(${JSON.stringify(once)})) {
  process.stderr.write('injected clear failure\\n')
  process.exit(1)
}
const out = spawnSync(${JSON.stringify(REAL_BUN)}, [${JSON.stringify(SIM)}, ...args], { env: process.env, encoding: 'utf8' })
const query = args.find((arg) => arg.startsWith('query=')) ?? ''
const comments = args.some((arg) => arg.includes('/comments?') || arg.endsWith('/comments'))
const countFile = ${JSON.stringify(path.join(dir, 'comment-reads'))}
const count = comments ? (existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0) + 1 : 0
if (comments) writeFileSync(countFile, String(count))
const baseRead = (args[args.indexOf('--json') + 1] ?? '') === 'baseRefName'
const baseCountFile = ${JSON.stringify(path.join(dir, 'base-reads'))}
const baseCount = baseRead ? (existsSync(baseCountFile) ? Number(readFileSync(baseCountFile, 'utf8')) : 0) + 1 : 0
if (baseRead) writeFileSync(baseCountFile, String(baseCount))
const when = ${JSON.stringify(when)}
const matches = when === 'base-read' ? baseRead
  : when === 'admission-base-read' ? baseRead && baseCount === 2
  : when === 'repository-read' ? args[0] === 'repo' && args[1] === 'view'
  : when === 'acquisition-comments' ? comments && count === 1
  : when === 'body-read' ? query.includes('lastEditedAt')
  : when === 'classification-read' ? query.includes('issueType')
  : when === 'admission-comments' ? comments && count === 2
  : when === 'pin-write' ? args[0] === 'pr' && args[1] === 'merge' && args.includes('--auto')
  : when === 'comment-write' ? (args[0] === 'api' && args.includes('POST') && args.some((arg) => arg.endsWith('/comments')))
  : when === 'disable-write' ? args[0] === 'pr' && args[1] === 'merge' && args.includes('--disable-auto')
  : when === 'remove-label-write' ? args[0] === 'pr' && args[1] === 'edit' && args.includes('--remove-label')
  : args[0] === 'pr' && args[1] === 'edit' && args.includes('--add-label')
if (out.status === 0 && matches && !existsSync(${JSON.stringify(once)})) {
  const state = JSON.parse(readFileSync(process.env.GH_SIM_STATE, 'utf8'))
  function retargetPullBase(prNumber, base) {
    const pull = state.prs[String(prNumber)]
    if (!pull) throw new Error('retargetPullBase: missing PR ' + prNumber)
    const previous = pull.baseRefName
    pull.baseRefName = base
    const header =
      /^<!-- omp-build-record v=1 kind=(workflow-binding|mandate) id=\\S+ operationId=\\S+ part=(\\d+)\\/(\\d+) data=([A-Za-z0-9_-]+) -->/
    const rewrite = (comment) => {
      const line = String(comment.body).split('\\n')[0] ?? ''
      const match = line.match(header)
      if (!match || match[2] !== '1' || match[3] !== '1') return
      const record = JSON.parse(Buffer.from(match[4], 'base64url').toString('utf8'))
      if (record?.payload?.base !== previous) return
      record.payload.base = base
      const data = Buffer.from(JSON.stringify(record)).toString('base64url')
      comment.body = comment.body.replace(match[4], data)
    }
    for (const comment of pull.comments ?? []) rewrite(comment)
    for (const issue of Object.values(state.issues ?? {})) {
      for (const comment of issue.comments ?? []) rewrite(comment)
    }
  }
  ${change}
  writeFileSync(process.env.GH_SIM_STATE, JSON.stringify(state))
  writeFileSync(${JSON.stringify(once)}, 'changed\\n')
}
process.stdout.write(out.stdout)
process.stderr.write(out.stderr)
process.exit(out.status ?? 1)
`,
  )
  chmodSync(shim, 0o755)
  box.env.PATH = `${dir}:${originalPath}`
  return () => {
    box.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  }
}
