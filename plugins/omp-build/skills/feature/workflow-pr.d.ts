import type { Gh } from './review-base.ts'

export type ReviewPr = number | string | null | undefined
export type ResolveReviewPrDeps = { gh?: Gh; git?: (cwd: string, args: readonly string[]) => Promise<string> }
export type OpenPrInput = { issue: number; branch: string; base: string; title: string; body?: string }
export type OpenPrDeps = {
  gh?: Gh
  repository?: string
  beforeCreate?: () => Promise<void>
  confirm?: (pr: number) => Promise<{ ok: true; recordId: string } | { ok: false; reason: string }>
}
export type OpenPrResult = { number: number; status: 'created' | 'existing'; binding?: string }

export declare function findOpenPr(
  cwd: string,
  head: string,
  base: string,
  gh: Gh,
  repository?: string,
): Promise<number | null>

/** Bind an explicit PR or discover the sole same-repository open PR for the current branch. */
export declare function resolveReviewPr(
  cwd: string,
  explicitPr?: ReviewPr,
  deps?: ResolveReviewPrDeps,
): Promise<number | null>
export declare function openPr(cwd: string, input?: OpenPrInput, deps?: OpenPrDeps): Promise<OpenPrResult>
/** Parse GitHub branch-protection and ruleset JSON into its distinct required contexts. */
export declare function parseRequiredContexts(apiJson: string): Set<string>
export declare function resolveRequiredContexts(cwd: string, base: string, ghFn?: Gh): Promise<string[]>
