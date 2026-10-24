export interface UvGitSource {
  git: string
  branch: string
}

export interface GitDep {
  name: string
  source: UvGitSource
}

export interface PinCandidate {
  name: string
  gitUrl: string
  branch: string
  sha: string
  tag: string
}

export interface PinSwapPlan {
  candidates: PinCandidate[]
}

export interface ApplyResult {
  written: boolean
  staged: boolean
}

export interface Deps {
  readFile: (path: string) => string
  writeFile: (path: string, content: string) => void
  run: (cmd: string[], cwd?: string) => Promise<string>
}
