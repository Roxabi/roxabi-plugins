import type { IssueRef, IssueWriter } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { GitHubOptions } from '../adapters/github/types.ts'
import type { Scope } from '../engine/record-values.ts'
import type { CauseEffectGuard } from './uw-cause-guard.ts'
import type { CreatedUwReadPort, OperatorPort, UwRead } from './uw-contract.ts'
import { type FramingReceiptPublication, publishFramingReceipt } from './uw-framing-identity.ts'
import { publishFramingIdentity } from './uw-identity-publication.ts'

type ReceiptRequest = Omit<Parameters<typeof publishFramingReceipt>[0], 'github'>
type IdentityRequest = Omit<Parameters<typeof publishFramingIdentity>[0], 'github' | 'reader'>

/** The installed publisher with its authenticated readback, bound once by composition. */
export type FramingPublicationPorts = {
  receipt(input: ReceiptRequest): Promise<FramingReceiptPublication>
  identity(input: IdentityRequest): ReturnType<typeof publishFramingIdentity>
}

export function createFramingPublicationPorts(
  github: GitHubOptions,
  reader: CreatedUwReadPort,
): FramingPublicationPorts {
  return {
    receipt: (input) => publishFramingReceipt({ ...input, github }),
    identity: (input) => publishFramingIdentity({ ...input, github, reader }),
  }
}

/** Existing installed capabilities only: the guarded issue writer, fresh reads, publication, and one confirmation. */
export type FramingExecutorPorts = {
  read(uw: Scope): Promise<UwRead>
  operator: OperatorPort
  guardParent(parent: IssueRef): Promise<void>
  guardedWriter(beforeEffect: CauseEffectGuard): IssueWriter
  scopeOf(issue: IssueRef): Scope
  framingPublication?: FramingPublicationPorts
}
