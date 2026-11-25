import type { Gh } from './review-base.ts'

export type BindingClaim = { issue?: number; branch?: string; base?: string }
export type SelectedBinding = { ok: true; recordId: string } | { ok: false; reason: string }

export declare function confirmSelectedBinding(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  claim?: BindingClaim,
): Promise<SelectedBinding>
