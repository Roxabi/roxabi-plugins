import path from 'node:path'
import { BRANCH } from '../testing/feature-recovery-fixture.ts'
import { git } from '../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../testing/sandbox/sandbox-types.ts'

export function coldCheckout(box: Box, name: string, branch = BRANCH): string {
  const principal = path.join(box.root, `${name}-principal`)
  const checkout = path.join(box.root, `${name}-checkout`)
  git(box, box.root, ['clone', '-q', box.origin, principal])
  git(box, principal, ['remote', 'set-url', 'origin', 'https://github.com/acme/app.git'])
  git(box, principal, ['config', `url.${box.origin}.insteadOf`, 'https://github.com/acme/app.git'])
  git(box, principal, ['worktree', 'add', '-q', '-b', branch, checkout, `origin/${branch}`])
  return checkout
}
