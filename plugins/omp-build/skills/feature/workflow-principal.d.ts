export type PrincipalBranch = 'staging' | 'main' | 'master'
export declare function pickPrincipal(present: ReadonlySet<string>): PrincipalBranch | null
export declare function detectPrincipal(cwd: string): Promise<PrincipalBranch>
