import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { seedReviewFixture } from './feature-review-fixture.ts'
import { createRecoveryTestRoot } from './fix-recovery-real-root.ts'
import { announcedBatch, createPreludeModel } from './fix-recovery-review-prelude-model.ts'
import { git, readSim, sandbox } from './sandbox/sandbox-repository.ts'
import type { Box, SimState } from './sandbox/sandbox-types.ts'

/** Both variants use a real committed Git head and an executable criterion test. */
export function arrangeRecoveryReviewFixture(mode: 'defect' | 'healthy' = 'defect'): { box: Box; cwd: string } {
  const branch = `feat/42-save-${randomUUID()}`
  const box = sandbox({
    base: { '.dev/stack.yml': 'package_manager: bun\nrelease:\n  model: trunk\n', 'README.md': 'base\n' },
    branches: [
      {
        name: branch,
        from: 'main',
        commits: [
          {
            message: 'feat: preserve region (#42)',
            files: {
              'src/save.ts':
                mode === 'healthy'
                  ? 'export function save(selected: string): string {\n  return selected\n}\n'
                  : 'export function save(selected: string): string {\n  return "us-east"\n}\n',
              'region.test.ts':
                'import { strict as assert } from "node:assert"\nimport { save } from "./src/save"\nassert.equal(save("eu-west"), "eu-west")\nconsole.log("PASS region")\n',
              'package.json': '{"private":true,"scripts":{"test":"bun run region.test.ts"}}\n',
            },
          },
        ],
      },
    ],
    issues: [{ number: 42, title: 'feat: preserve region', labels: ['size:F-lite'] }],
    prs: [{ number: 7, branch, title: 'feat: preserve region', body: 'Closes #42', closes: [42] }],
  })
  git(box, box.root, ['--git-dir', box.origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(box, box.principal, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const cwd = join(box.root, 'feature')
  git(box, box.principal, ['worktree', 'add', '-q', cwd, branch])
  return { box, cwd }
}

function records(stateFile: string) {
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as SimState
  const comments = state.prs['7']?.comments ?? []
  return decodeHistory({
    scope: { repository: 'acme/app', target: 'acme/app#7' },
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: comments.map((comment, index) => ({
      locator: `acme/app#7:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
  }).operations.flatMap((operation) => (operation.record ? [operation.record] : []))
}

function reviewResult(all: CanonicalRecord[], mode: 'defect' | 'healthy') {
  const review = all.findLast((item) => item.kind === 'review')
  const decision = all.findLast((item) => item.kind === 'decision')
  if (!review || !decision) return null
  const blocking = decision.payload.judgment.findings.some((item) => item.label === 'issue(blocking)')
  if (
    review.payload.decisionId !== decision.recordId ||
    decision.payload.judgment.purpose !== 'review' ||
    blocking !== (mode === 'defect')
  )
    throw new Error(
      `review-prelude-unexpected-decision:${JSON.stringify({ mode, review: review.payload, decision: decision.payload })}`,
    )
  return { review, decision }
}

function assertBoundary(
  started: boolean,
  approvals: number,
  dispatches: number,
  children: number,
  probes: number,
  diagnostic: () => unknown,
) {
  if (!started || approvals === 0 || dispatches === 0 || children === 0 || probes === 0)
    throw new Error(`review-prelude-boundary-not-observed:${JSON.stringify(diagnostic())}`)
}

/** Historical setup is structural only; every new review record is published by the real host. */
export async function runRecoveryReviewPrelude(input: {
  box: Box
  cwd: string
  rootDir: string
  credential: string
  mode?: 'defect' | 'healthy'
}) {
  const { box, cwd, rootDir, credential, mode = 'defect' } = input
  box.env = process.env
  const branch = readSim(box).prs['7']?.headRefName
  if (!branch) throw new Error('review-prelude-branch-missing')
  await seedReviewFixture(box, cwd, branch, 'bun run test')
  const approvals: unknown[] = []
  const dialogs: string[] = []
  const notifications: string[] = []
  const model = createPreludeModel(mode)
  let confirmations = 0
  const root = await createRecoveryTestRoot({
    cwd,
    agentDir: join(rootDir, 'review-prelude-agent'),
    sandboxHome: rootDir,
    ghConfigDir: join(rootDir, 'gh-config'),
    ghSimulatorState: box.stateFile,
    credential,
    responses: [],
    agentModelOverrides: Object.fromEntries(
      ['adversarial', 'security-auditor', 'architect', 'devops', 'tester', 'spec', 'synthesis', 'recall'].map(
        (name) => [`R-review-${name}`, 'recovery-test/recovery-test'],
      ),
    ),
    onApproval: async (prompt) => {
      approvals.push(prompt)
      return 'once'
    },
    onConfirmation: async () => {
      confirmations++
      return 'confirm'
    },
    onDisplay: (text) => dialogs.push(text),
    onNotification: (text) => notifications.push(text),
    handler: model.handler,
  })
  try {
    await root.session.prompt('/tooling-pin activate')
    if (
      !notifications.includes('tooling-pin: activated for this session') &&
      !notifications.includes('tooling-pin: tooling-pin-not-needed')
    )
      throw new Error(`review-prelude-pin-refused:${JSON.stringify(notifications)}`)
    await root.session.prompt('Start the structured review of pull request 7.')
    model.batchPhase()
    const diagnostic = () => ({
      startCalled: model.started(),
      approvals: approvals.length,
      confirmations,
      announced: [...model.dispatched],
      nativeDispatches: root.nativeDispatches,
      children: root.children,
      probes: model.probes,
      providerCalls: model.calls,
      dialogs,
      notifications,
      errors: root.errors,
      messages: root.session.messages,
      contributions: records(box.stateFile).filter((record) => record.kind === 'contribution'),
    })
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const result = reviewResult(records(box.stateFile), mode)
      if (result) {
        const { review, decision } = result
        assertBoundary(
          model.started(),
          approvals.length,
          root.nativeDispatches.length,
          root.children.length,
          model.probes.length,
          diagnostic,
        )
        return {
          reviewId: review.recordId,
          decisionId: decision.recordId,
          review,
          decision,
          nativeDispatches: [...root.nativeDispatches],
          children: [...root.children],
          childProbes: model.probes,
          childToolCalls: model.probes.length,
          approvals: approvals.length,
          confirmations,
          dialogs,
          notifications,
          errors: root.errors,
        }
      }
      if (notifications.some((message) => message.includes('continuation stopped')))
        throw new Error(`review-prelude-terminal-stop:${JSON.stringify(diagnostic())}`)
      if (announcedBatch(root.session.messages, model.dispatched))
        await root.session.prompt('Execute the announced native review batch.')
      else await delay(25)
    }
    throw new Error(`review-prelude-timeout:${JSON.stringify(diagnostic())}`)
  } finally {
    await root.dispose()
  }
}
