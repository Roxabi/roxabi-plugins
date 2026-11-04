import path from 'node:path'
import { REVIEW_BRANCH } from './feature-review-fixture.ts'
import { git, sandbox } from './sandbox/sandbox-repository.ts'

/** Two files larger together than the test driver's 1,200-line chunk budget. */
export function arrangeRecallReviewFixture() {
  const lines = `${Array.from({ length: 700 }, (_, index) => `export const value${index} = ${index}`).join('\n')}\n`
  const box = sandbox({
    base: { '.dev/stack.yml': 'package_manager: bun\n', 'README.md': 'base\n' },
    branches: [
      {
        name: REVIEW_BRANCH,
        from: 'main',
        commits: [
          {
            message: 'feat: preserve region',
            files: {
              'src/save.ts': 'export const save = true\n',
              'src/first.ts': lines,
              'src/second.ts': lines,
            },
          },
        ],
      },
    ],
    issues: [{ number: 42, title: 'feat: preserve region', labels: ['size:F-lite'] }],
    prs: [{ number: 7, branch: REVIEW_BRANCH, title: 'feat: preserve region', body: 'Closes #42', closes: [42] }],
  })
  const cwd = path.join(box.root, 'feature')
  git(box, box.principal, ['worktree', 'add', '-q', cwd, REVIEW_BRANCH])
  return { box, cwd }
}
