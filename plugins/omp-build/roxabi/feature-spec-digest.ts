import { canonicalValueDigest, type SpecEffective } from '../dist/contracts.js'

export function featureSpecDigest(acceptedSpec: SpecEffective): string {
  return canonicalValueDigest(acceptedSpec)
}
