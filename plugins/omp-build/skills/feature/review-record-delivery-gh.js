import { CHECKOUT_BASE, readFixtureGit } from './review-record-git-fixture.js'

function commit(sha) {
  const [actual, ...parents] = readFixtureGit(['rev-list', '--parents', '-n', '1', sha]).split(' ')
  if (actual !== sha) throw new Error(`Unknown fixture commit ${sha}`)
  return { sha: actual, parents: parents.map((parent) => ({ sha: parent })) }
}

function comparison(base, head, page) {
  commit(base)
  commit(head)
  const ahead = readFixtureGit(['rev-list', '--reverse', `${base}..${head}`])
    .split('\n')
    .filter(Boolean)
  const behind = readFixtureGit(['rev-list', '--count', `${head}..${base}`])
  const status = ahead.length === 0 ? (behind === '0' ? 'identical' : 'behind') : behind === '0' ? 'ahead' : 'diverged'
  return JSON.stringify({
    status,
    total_commits: ahead.length,
    commits: ahead.slice((page - 1) * 100, page * 100).map(commit),
  })
}

/** GitHub delivery evidence backed by the fixture's actual Git object graph. */
function reviewDeliveryGitResponse(args, repository) {
  if (args[0] !== 'api' || args.includes('--method')) return null
  const endpoint = String(args[1] ?? '')
  const prefix = `repos/${repository}/`
  if (!endpoint.startsWith(prefix)) return null
  const path = endpoint.slice(prefix.length)
  const single = /^git\/commits\/([a-f0-9]{40})$/.exec(path)
  if (single) return JSON.stringify(commit(single[1]))
  const range = /^compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})\?per_page=100&page=([1-9][0-9]*)$/.exec(path)
  if (!range) return null
  const page = Number(range[3])
  if (!Number.isSafeInteger(page)) throw new Error('Invalid fixture comparison page')
  return comparison(range[1], range[2], page)
}

function reviewDeliveryPullsResponse(args, fixture) {
  if (args[0] !== 'api' || args[1] !== 'graphql') return null
  const query = args.find((arg) => String(arg).startsWith('query='))
  if (
    typeof query !== 'string' ||
    !query.includes('pullRequests(first:100,after:$cursor,states:[OPEN,CLOSED,MERGED],headRefName:$branch)')
  )
    return null
  const [owner, name] = fixture.repository.split('/')
  if (
    !args.includes(`owner=${owner}`) ||
    !args.includes(`name=${name}`) ||
    args.some((arg) => String(arg).startsWith('cursor='))
  )
    throw new Error('Unexpected fixture pull enumeration scope or cursor')
  const branch = args.find((arg) => String(arg).startsWith('branch='))
  return JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          nodes:
            branch === undefined || branch === 'branch=feat/save'
              ? [
                  {
                    number: fixture.pr,
                    headRefName: 'feat/save',
                    baseRefName: 'main',
                    repository: { nameWithOwner: fixture.repository },
                  },
                ]
              : [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  })
}

export function createReviewDeliveryNative(fixture) {
  return {
    base: CHECKOUT_BASE,
    response: (args) =>
      reviewDeliveryPullsResponse(args, fixture) ?? reviewDeliveryGitResponse(args, fixture.repository),
  }
}
