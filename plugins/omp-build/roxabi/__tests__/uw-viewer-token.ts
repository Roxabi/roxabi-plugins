import { randomUUID } from 'node:crypto'

let restoreViewer: (() => void) | null = null

/** Isolates the process-wide GitHub viewer cache from the operator token. */
export function isolateViewerToken(): void {
  restoreViewer?.()
  const token = process.env.GH_TOKEN
  const github = process.env.GITHUB_TOKEN
  const fixture = `normalization-${randomUUID()}`
  process.env.GH_TOKEN = fixture
  process.env.GITHUB_TOKEN = fixture
  restoreViewer = () => {
    if (token === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = token
    if (github === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = github
    restoreViewer = null
  }
}

export function releaseViewerToken(): void {
  restoreViewer?.()
}
