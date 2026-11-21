import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { readGitHubHistory } from '../../adapters/github/transport.ts'
import { arrangeReviewFixture, seedReviewFixture } from '../../testing/feature-review-fixture.ts'
import { seedFixRecoveryPrefix } from '../../testing/fix-recovery-prefix-fixture.ts'
import { validateOriginatingFixSettlement } from '../fix-originating-settlement.ts'

const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('reconciles only the exact enrolled torn publication and refuses unrelated or changed claims', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  await seedReviewFixture(box, cwd)
  const fixture = await seedFixRecoveryPrefix(box, cwd)
  const options = {
    cwd,
    readAuthor: 'operator',
    gh: async (dir: string, args: string[]) => execFileSync('gh', args, { cwd: dir, env: box.env, encoding: 'utf8' }),
  }
  const home = decodeHistory(await readGitHubHistory(fixture.uw, options))
  const pull = decodeHistory(await readGitHubHistory(fixture.pullRequest, options))
  const settlement = home.operations.find(
    (operation) => operation.record?.kind === 'fix-owner' && operation.record.payload.phase === 'settled',
  )?.record
  if (settlement?.kind !== 'fix-owner' || settlement.payload.phase !== 'settled')
    throw new Error('fixture settlement missing')
  const torn = pull.operations.find((operation) => operation.operationId === fixture.source.operationId)
  if (torn === undefined || torn.status !== 'incomplete') throw new Error('fixture torn source missing')

  const reconciled = validateOriginatingFixSettlement({ record: settlement, histories: [home, pull] })
  expect(reconciled.ok, JSON.stringify(reconciled)).toBe(true)
  const unrelated = { ...torn, operationId: `${torn.operationId}-other`, recordId: `${torn.recordId}-other` }
  expect(
    validateOriginatingFixSettlement({
      record: settlement,
      histories: [home, { ...pull, operations: [...pull.operations, unrelated] }],
    }).ok,
  ).toBe(false)
  const altered = {
    ...settlement,
    payload: {
      ...settlement.payload,
      outbound: settlement.payload.outbound.map((entry, index) =>
        index === 0
          ? { ...entry, identity: { ...entry.identity, operationId: `${entry.identity.operationId}-other` } }
          : entry,
      ),
    },
  }
  expect(validateOriginatingFixSettlement({ record: altered, histories: [home, pull] }).ok).toBe(false)
  expect(validateOriginatingFixSettlement({ record: settlement, histories: [home] }).ok).toBe(false)
})
