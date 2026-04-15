// Barrel re-export. Real implementations live in the three sibling modules below,
// each with a single orthogonal concern (store I/O, GitHub discovery, cwd resolution).
// Existing importers of `./workspace` keep working unchanged.

export * from './cwd-resolver'
export * from './github-discovery'
export * from './workspace-store'
