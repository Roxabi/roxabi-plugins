import type { PublicationContextResolver } from '../adapters/github/publication-context.ts'
import type { Gh, GitHubOptions } from '../adapters/github/types.ts'
import type { ActionInputs, CanonicalRecord, Scope } from '../dist/contracts.js'
import {
  actionInputsSchema,
  causeHistoryReferences,
  gh as githubClient,
  isRetainedReportPublication,
  readComposedWorkflowHistory,
} from '../dist/contracts.js'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import { readReviewInputHistories } from './uw-input-readers.ts'

function candidateInputs(record: CanonicalRecord): ActionInputs[] {
  if (record.kind !== 'review-attempt') return []
  const inputs: ActionInputs[] = []
  const snapshot = 'inputSnapshot' in record.payload ? actionInputsSchema.safeParse(record.payload.inputSnapshot) : null
  if (snapshot?.success) inputs.push(snapshot.data)
  for (const slot of record.payload.slots) {
    const parsed = actionInputsSchema.safeParse(slot.action?.inputs)
    if (parsed.success) inputs.push(parsed.data)
  }
  return inputs
}

function inputScopes(input: ActionInputs): Scope[] {
  const manifest = input.manifest
  const scopes: Scope[] = []
  if (manifest.subject.kind === 'uw') {
    scopes.push(manifest.subject.uw)
    if (manifest.subject.pullRequest !== null) scopes.push(manifest.subject.pullRequest)
    if (manifest.subject.binding !== null) scopes.push(manifest.subject.binding.record.scope)
  } else scopes.push(manifest.subject.pullRequest)
  for (const ref of [...manifest.acceptedSources, ...manifest.deliveryData, ...input.stageSources])
    scopes.push(ref.record.scope)
  for (const ref of manifest.expandedContext) if (ref.source === 'record') scopes.push(ref.record.scope)
  return scopes
}

async function historicalPromotionContext(record: CanonicalRecord, options: GitHubOptions) {
  const scopes = record.kind === 'report-promotion' ? [record.payload.identity.scope] : []
  const observed =
    scopes.length === 0 ? { ok: true as const, histories: [] } : await readComposedWorkflowHistory(scopes, options)
  if (!observed.ok) return { ok: false as const, diagnostics: observed.diagnostics }
  return { ok: true as const, value: { config: null, externalHistories: observed.histories } }
}
function publicationScopes(
  record: CanonicalRecord,
  history: Parameters<PublicationContextResolver>[0]['history'],
  externalHistories: Parameters<PublicationContextResolver>[0]['externalHistories'],
  candidate: readonly ActionInputs[],
): Map<string, Scope> {
  const scopes = new Map<string, Scope>()
  const root = history.source.scope
  const add = (scope: Scope) => {
    if (scope.repository !== root.repository || scope.target !== root.target)
      scopes.set(`${scope.repository}\0${scope.target}`, scope)
  }
  for (const item of externalHistories) add(item.source.scope)
  for (const ref of causeHistoryReferences([record])) add(ref.scope)
  for (const inputs of candidate) for (const scope of inputScopes(inputs)) add(scope)
  return scopes
}

/** One refresh boundary: evidence and complete external closure match the current native history. */
export function createPublicationContextResolver(
  options: GitHubOptions,
  acceptedPolicy: string | null,
): PublicationContextResolver {
  const gh: Gh = githubClient(options)
  return async ({ record, history, externalHistories }) => {
    if (isRetainedReportPublication(record)) return historicalPromotionContext(record, options)
    const candidate = candidateInputs(record)
    const scopes = publicationScopes(record, history, externalHistories, candidate)
    const cited = await readReviewInputHistories(history, { cwd: options.cwd, gh, readAuthor: options.readAuthor }, [
      ...scopes.values(),
    ])
    if (!cited.ok) return cited
    const catalogues = await loadReviewClassCatalogues({
      histories: [history, ...cited.value],
      candidateInputs: candidate,
      cwd: options.cwd,
      gh,
    })
    return {
      ok: true,
      value: {
        config: { catalogues, acceptedPolicy },
        externalHistories: cited.value,
      },
    }
  }
}
