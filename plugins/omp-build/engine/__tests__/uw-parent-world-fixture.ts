import type { NativeEpicFacts } from '../../testing/native-implementation-transport-epic.ts'
import type { NativeWorldFacts, withNativeImplementationWorld } from '../../testing/native-implementation-world.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { Scope } from '../record-values.ts'
import type { ParentDeliveryWorld } from './uw-delivery-proof-fixture.ts'

type Native = Parameters<Parameters<typeof withNativeImplementationWorld>[1]>[0]
type Parent = ParentDeliveryWorld['parent']

type Context = {
  git: { originUrl?: string }
  parent: Parent
  selectParentInWorld:
    | ((world: Native, parent: Parent) => Promise<{ mandate: Parent; history: DecodedHistory }>)
    | undefined
  makeReviews: (parent: Parent, history: DecodedHistory) => Promise<ParentDeliveryWorld['reviews']>
  reviews: ParentDeliveryWorld['reviews']
  histories: readonly DecodedHistory[]
  repository: string
  pullRequests: NativeWorldFacts['pullRequests']
  deliveredEpic: NativeEpicFacts
  parentScope: Scope
  p0: string
  merges: readonly string[]
  heads: readonly string[]
  parentHead: string
}

async function seedHistory(
  active: Native,
  history: DecodedHistory,
  histories: readonly DecodedHistory[],
  repository: string,
) {
  const number = history.source.scope.target.split('#')[1]
  if (!number) throw new Error('Missing native history number')
  const seededIdentityParts = new Set(
    histories
      .filter((seed) => seed.source.scope.target === history.source.scope.target)
      .flatMap((seed) => seed.source.comments.map((comment) => comment.body)),
  )
  for (const comment of history.source.comments) {
    if (seededIdentityParts.has(comment.body)) continue
    await active.gh(active.cwd, [
      'api',
      '--method',
      'POST',
      `repos/${repository}/issues/${number}/comments`,
      '-f',
      `body=${comment.body}`,
    ])
  }
}

async function seedReviews(
  active: Native,
  reviews: ParentDeliveryWorld['reviews'],
  histories: readonly DecodedHistory[],
  repository: string,
) {
  for (const entry of reviews)
    for (const history of [entry.review.issueHistory, entry.review.history])
      await seedHistory(active, history, histories, repository)
}

export async function completeDeliveryWorld<T>(
  native: Native,
  context: Context,
  use: (world: ParentDeliveryWorld) => Promise<T>,
) {
  const {
    git,
    parent,
    selectParentInWorld,
    makeReviews,
    reviews,
    histories,
    repository,
    pullRequests,
    deliveredEpic,
    parentScope,
    p0,
    merges,
    heads,
    parentHead,
  } = context
  const active = git.originUrl === undefined ? native : await native.at(native.cwd)
  let activeParent = parent
  if (selectParentInWorld) {
    const selected = await selectParentInWorld(active, parent)
    activeParent = selected.mandate
    reviews.push(...(await makeReviews(selected.mandate, selected.history)))
    await seedReviews(active, reviews, histories, repository)
    for (const pull of pullRequests) active.observePullRequest(pull)
    active.observeEpic(deliveredEpic)
  }
  const read = await active.operations.readUw(parentScope)
  if (read.observation.status !== 'complete')
    throw new Error(`Parent world observation incomplete: ${JSON.stringify(read.observation.diagnostics)}`)
  return use({
    observation: read.observation,
    parent: activeParent,
    parentScope,
    reviews,
    p0,
    merges,
    heads,
    parentHead,
    gh: active.gh,
    ghSync: active.ghSync,
    git: active.git,
    operations: active.operations,
    checkout: active.checkout,
    observeGraph: active.observeGraph,
    at: active.at,
    observeEpic: active.observeEpic,
    observePullRequest: active.observePullRequest,
  })
}
