import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { withEpicNativeFinalReview } from '../skills/feature/testing/epic-driver/epic-driver-native-final-review.ts'
import { strictSpecBody } from '../skills/feature/testing/epic-driver/epic-driver-records.ts'

it('prepares and publishes the direct Parent review after a stable presentation-only Spec edit', async () => {
  await withEpicNativeFinalReview(
    async (proof) => {
      expect(proof.presentation).not.toBeNull()
      expect(proof.completion).toMatchObject({ state: 'complete', role: 'parent' })
      expect(proof.input.manifest.deliveryData).toContainEqual({ ...proof.integration, role: 'integration' })
      const { base, head, referenceCommit } = proof.input.manifest.code
      expect({ range: proof.range, base, referenceCommit }).toEqual({
        range: `${head}..${head}`,
        base: head,
        referenceCommit: head,
      })
      expect(proof.initialTasks.map((task) => task.agent)).toContain('R-review-spec')
    },
    {
      editPresentation: true,
      onPresentation(before, after) {
        if (before.parsed.status !== 'conformant' || after.parsed.status !== 'conformant')
          throw new Error('Expected conformant native Parent Specs')
        expect(after.parsed.snapshot.spec).toEqual(before.parsed.snapshot.spec)
        expect(after.parsed.snapshot.raw.body).toBe(`${before.parsed.snapshot.raw.body}\n`)
        expect(after.parsed.snapshot.raw.bodySha256).not.toBe(before.parsed.snapshot.raw.bodySha256)
        expect(after.parsed.snapshot.raw.lastEditedAt).toBe('2026-10-22T12:00:00Z')
        expect(after.accepted).toEqual(before.accepted)
      },
      async onPrepared(prepared, issueFile) {
        const original = readFileSync(issueFile, 'utf8')
        const issue = JSON.parse(original)
        const authorize = () => prepared.publisher.authorize(prepared.context, prepared.prepared.stage)
        expect(await authorize()).toMatchObject({ ok: true })
        issue.data.repository.issue.body = strictSpecBody('materially changed')
        writeFileSync(issueFile, JSON.stringify(issue))
        expect(await authorize()).toMatchObject({ ok: false })
        issue.data.repository.issue.body = JSON.parse(original).data.repository.issue.body
        issue.data.repository.issue.labels.nodes = [{ name: 'size:F-lite' }]
        writeFileSync(issueFile, JSON.stringify(issue))
        expect(await authorize()).toMatchObject({ ok: false })
        issue.data.repository.issue.labels.nodes = JSON.parse(original).data.repository.issue.labels.nodes
        issue.data.repository.issue.body += '\n'
        writeFileSync(issueFile, JSON.stringify(issue))
        expect(await authorize()).toMatchObject({ ok: false })
        writeFileSync(issueFile, original)
        expect(await authorize()).toMatchObject({ ok: true })
      },
    },
  )
})
