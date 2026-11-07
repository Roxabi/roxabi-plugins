import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../contracts.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { discoverAcceptedChildPrs } from './epic-driver-containment.ts'
import { withEpicEffects } from './epic-driver-runtime.ts'
import { inheritedParentSpecs } from './testing/epic-driver/epic-driver-parent-vector.ts'
import {
  childNode,
  framedRecords,
  ME,
  prNode,
  serveComments,
  serveEpic,
  servePr,
  strictSpecBody,
} from './testing/epic-driver/epic-driver-records.ts'
import { cleanupSandbox, sandbox } from './testing/epic-driver/epic-driver-sandbox.ts'

afterEach(cleanupSandbox)

function snapshot(scope: { repository: string; target: string }, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-21T12:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error('Expected conformant native Spec')
  return parsed.snapshot
}

test.each(['legacy', 'framed'] as const)(
  'foreign %s mandate copies cannot veto authenticated accepted-child PR containment',
  async (kind) => {
    const box = sandbox()
    const parentScope = { repository: 'o/r', target: 'o/r#1' }
    const childScope = { repository: 'o/r', target: 'o/r#2' }
    const prScope = { repository: 'o/r', target: 'o/r#11' }
    const branch = 'feat/2-first-child'
    const sha = 'a'.repeat(40)
    const node = childNode(2, 'feat(x): first child', { prs: [prNode(11, branch, sha)] })
    const fixtures = roxabiWorkflowFixtures()
    const parentBody = strictSpecBody('works')
    const childSnapshot = snapshot(childScope, node.body)
    const parent = fixtures.epicMandate(
      parentScope,
      [{ scope: childScope, snapshot: childSnapshot, specVersion: childSnapshot.spec.version, tier: 'S' }],
      { body: parentBody, ownSpec: fixtures.ownSpecFromSnapshot(parentScope, snapshot(parentScope, parentBody)) },
    )
    const child = fixtures.featureMandate(childScope, {
      body: node.body,
      ownSpec: fixtures.ownSpecFromSnapshot(childScope, childSnapshot),
      parent: fixtures.mandateRef(parent),
      inheritedOwnSpecRefs: inheritedParentSpecs(parent),
      branch,
    })
    const parentHistory = fixtures.historyFrom([parent])
    const childHistory = fixtures.historyFrom([child], ME, ME, [parentHistory])
    const binding = fixtures.workflowBinding(prScope, child, branch, 'main')
    const childComments = fixtures.framedBodies([child], ME, [parentHistory]).map((body) => ({ body, author: ME }))
    serveEpic([{ ...node, fixtureComments: childComments }], framedRecords(1, [parent]), { mandate: false })
    serveComments(
      11,
      fixtures.framedBodies([binding], ME, [childHistory, parentHistory]).map((body) => ({ body, author: ME })),
    )
    servePr(11, { state: 'OPEN', labels: ['reviewed'], autoMerge: false })
    const authorization = createRequire(import.meta.url)('../../vendor/kit-head-authorization/index.cjs') as {
      render: (record: Record<string, unknown>) => string
    }
    const prComments = path.join(box.state, 'comments-11.json')
    const rows = JSON.parse(readFileSync(prComments, 'utf8'))
    rows.push({
      id: 900011,
      node_id: 'IC_900011',
      body: authorization.render({
        version: 1,
        kind: 'grant',
        operationId: 'fixture-grant-11',
        repositoryId: 1,
        pullRequestId: 1011,
        pullRequest: 11,
        headSha: sha,
        baseRef: 'main',
        baseSha: sha,
        lane: 'reviewed',
        source: 'native',
        previous: null,
        evidence: 'fixture-review',
      }),
      user: { login: 'operator', id: 101, type: 'User' },
      performed_via_github_app: null,
      created_at: '2026-10-21T10:00:00Z',
      updated_at: '2026-10-21T10:00:00Z',
    })
    writeFileSync(prComments, JSON.stringify(rows))
    const run = (parentId = parent.recordId) =>
      withEpicEffects(
        {
          gh: (cwd, args, input) => execFileSync('gh', args, { cwd, env: box.env, input, encoding: 'utf8' }),
        },
        () => discoverAcceptedChildPrs(box.epic, 'o/r', 1, parentId, parent.payload.children),
      )
    expect(await run()).toEqual([{ ticket: 2, pr: 11 }])
    await expect(run('wrong-parent')).rejects.toThrow()
    serveComments(11, [])
    await expect(run()).rejects.toThrow()
    writeFileSync(prComments, JSON.stringify(rows))
    const childFile = path.join(box.state, 'comments-2.json')
    const edited = JSON.parse(readFileSync(childFile, 'utf8'))
    const ownPart = edited.find((entry: { body: string }) => entry.body.includes('kind=mandate '))
    if (!ownPart) throw new Error('Expected native child mandate')
    ownPart.updated_at = '2026-10-22T10:00:00Z'
    writeFileSync(childFile, JSON.stringify(edited))
    await expect(run()).rejects.toThrow()
    serveComments(2, [{ body: '<!-- omp-build:mandate -->', author: 'intruder' }])
    await expect(run()).rejects.toThrow()
    serveComments(2, [...childComments, { body: '<!-- omp-build:mandate -->', author: ME }])
    await expect(run()).rejects.toThrow()
    serveComments(2, [
      ...childComments,
      {
        body: '<!-- omp-build-record v=1 kind=mandate id=broken operationId=op-broken part=1/2 data=e30 -->\n# partial',
        author: ME,
      },
    ])
    await expect(run()).rejects.toThrow()
    const extra =
      kind === 'legacy'
        ? [{ body: '<!-- omp-build:mandate -->', author: 'intruder' }]
        : childComments.map((entry) => ({ ...entry, author: 'intruder' }))
    serveComments(2, [...childComments, ...extra])
    expect(await run()).toEqual([{ ticket: 2, pr: 11 }])
  },
)
