import { settleAll } from './sim-git.ts'
import { fail, fullName, type State } from './sim-types.ts'

export const DELIVERY_PULLS =
  'query($owner:String!,$name:String!,$cursor:String,$branch:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$cursor,states:[OPEN,CLOSED,MERGED],headRefName:$branch){pageInfo{hasNextPage endCursor}nodes{number headRefName baseRefName repository{nameWithOwner}}}}}'

export function deliveryPulls(state: State, cursor: string | undefined, branch: string | undefined): unknown {
  const offset = cursor === undefined ? 0 : Number(cursor)
  if (!Number.isSafeInteger(offset) || offset < 0 || (cursor !== undefined && String(offset) !== cursor))
    fail('gh: invalid delivery pull request cursor')
  settleAll(state)
  const pulls = Object.values(state.prs)
    .filter((pr) => branch === undefined || pr.headRefName === branch)
    .sort((left, right) => left.number - right.number)
  const page = pulls.slice(offset, offset + 100)
  const next = offset + page.length
  return {
    data: {
      repository: {
        pullRequests: {
          nodes: page.map((pr) => ({
            number: pr.number,
            headRefName: pr.headRefName,
            baseRefName: pr.baseRefName,
            repository: { nameWithOwner: fullName(state) },
          })),
          pageInfo: { hasNextPage: next < pulls.length, endCursor: next < pulls.length ? String(next) : null },
        },
      },
    },
  }
}
