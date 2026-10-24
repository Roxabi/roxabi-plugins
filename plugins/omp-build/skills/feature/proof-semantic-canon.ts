import type { ProofSemanticContext } from './proof-context'

export type ReviewSemanticCanon = string

export function reviewSemanticCanon(semantic: ProofSemanticContext): ReviewSemanticCanon {
  if (semantic.mode === 'standalone') {
    return JSON.stringify(
      semantic.discoveredSpec === null
        ? ['standalone', null]
        : [
            'standalone',
            semantic.discoveredSpec.reference,
            semantic.discoveredSpec.body,
            semantic.discoveredSpec.digest,
          ],
    )
  }
  return JSON.stringify([
    'bound',
    semantic.bindingId,
    semantic.scope.repository,
    semantic.scope.target,
    semantic.acceptedSpec.reference,
    semantic.acceptedSpec.body,
    semantic.acceptedSpec.digest,
    semantic.chain,
    semantic.sourceRefs,
    [...semantic.requirements],
    semantic.config.productVersion,
    semantic.config.version,
    semantic.config.digest,
    semantic.config.serialized,
  ])
}
