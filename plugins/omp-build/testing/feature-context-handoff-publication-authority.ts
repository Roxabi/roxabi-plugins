import type { GitRunner } from '../roxabi/workflow-checkout.ts'

/** Gate the Nth `rev-parse HEAD` (successorShared config preparation) without mutating durable replies. */
export function gateSuccessorConfigReads(
  git: GitRunner,
  triggerOnCall: number,
): {
  git: GitRunner
  entered: Promise<void>
  release: () => void
  headReads: () => number
} {
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  let headReads = 0
  return {
    entered: entered.promise,
    release: () => gate.resolve(),
    headReads: () => headReads,
    git: async (cwd, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        headReads += 1
        if (headReads === triggerOnCall) {
          entered.resolve()
          await gate.promise
        }
      }
      return git(cwd, args)
    },
  }
}

/** Count GitHub comment POSTs without inventing publisher policy. */
export function countCommentPosts(gh: (cwd: string, args: string[]) => Promise<string>): {
  gh: typeof gh
  posts: () => number
  bodies: () => string[]
} {
  let posts = 0
  const bodies: string[] = []
  return {
    posts: () => posts,
    bodies: () => bodies,
    gh: async (cwd, args) => {
      if (args.includes('POST')) {
        posts += 1
        const bodyArg = args.find((arg) => arg.startsWith('body='))
        if (bodyArg !== undefined) bodies.push(bodyArg.slice('body='.length))
      }
      return gh(cwd, args)
    },
  }
}
