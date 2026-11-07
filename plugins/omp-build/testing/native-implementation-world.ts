import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Gh } from '../adapters/github/types.ts'
import type { ActionInputManifest, PinnedFileRef } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import { prepareUwAction, replayUwActionInputs } from '../roxabi/uw-action-inputs.ts'
import type { OperatorPort, UwOperations } from '../roxabi/uw-contract.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import type { GitRunner } from '../roxabi/workflow-checkout.ts'
import { defaultGit } from '../roxabi/workflow-checkout.ts'
import { nativeActionFixturePorts } from './native-action-ports.ts'
import { declaredNativeGit } from './native-declared-git.ts'
import { arrangeNativeImplementation, type NativeImplementationInput } from './native-implementation-arrangement.ts'
import { createNativeImplementationTransport } from './native-implementation-transport.ts'
import type { NativeEpicFacts } from './native-implementation-transport-epic.ts'

export type NativeWorldFacts = {
  commits: readonly {
    sha: string
    parents: readonly string[]
    tree: string
    subject: string
    paths: readonly string[]
    config: string | null
  }[]
  pullRequests: readonly {
    scope: Scope
    branch: string
    base: string
    head: string
    baseTip: string
    state: 'OPEN' | 'CLOSED' | 'MERGED'
    mergeCommit: string | null
    mergedAt?: string | null
    gate?: { labels: readonly string[]; autoMerge: { enabledAt: string } | null }
    author: string | null
  }[]
  comparisons: readonly { base: string; head: string; status: 'ahead' | 'identical'; commits: readonly string[] }[]
  author: string
  graph: Extract<UwGraphObservation, { status: 'complete' }>
  histories: readonly DecodedHistory[]
  authorization?: { repositoryId: number; operatorId: number; appId: number; botUserId: number }
}

export type DeclaredCheckout = {
  branch: string | null
  head: string
  base: string
  baseTip: string
  remoteTip: string | null
}

type NativeWorldSeed = NativeWorldFacts & {
  anchor: Scope
  plugin: ActionInputManifest['plugin']
  checkout: DeclaredCheckout
  diffs: readonly { base: string; head: string; bytes: Uint8Array }[]
  repositoryFiles?: readonly { ref: PinnedFileRef; bytes: Uint8Array }[]
  operator?: OperatorPort
  originUrl?: string
  epic?: NativeEpicFacts
  cwd?: string
}

type NativeWorld = {
  cwd: string
  gh: Gh
  ghSync(cwd: string, args: string[]): string
  git: GitRunner
  operations: UwOperations
  checkout(facts: DeclaredCheckout): void
  observeGraph(graph: NativeWorldFacts['graph']): void
  observePullRequest(facts: NativeWorldFacts['pullRequests'][number]): void
  editComment(scope: Scope, nativeId: string, body: string, updatedAt: string, author?: string): void
  at(cwd: string): Promise<NativeWorld>
}

/** One callback owns a persistent, explicitly declared native and Git world. */
export async function withNativeImplementationWorld<T>(
  input: NativeWorldSeed,
  use: (world: NativeWorld) => Promise<T>,
): Promise<T> {
  const owned = input.cwd === undefined
  const cwd = input.cwd ?? mkdtempSync(join(tmpdir(), 'omp-native-implementation-'))
  const artifactsDir = mkdtempSync(join(tmpdir(), 'omp-native-action-artifacts-'))
  try {
    const repository = input.anchor.repository
    const commits = new Map(input.commits.map((commit) => [commit.sha, commit]))
    const pulls = new Map(input.pullRequests.map((pull) => [pull.scope.target, pull]))
    const comparisons = new Map(
      input.comparisons.map((comparison) => [`${comparison.base}\0${comparison.head}`, comparison]),
    )
    const repositoryFiles = new Map(
      (input.repositoryFiles ?? []).map(({ ref, bytes }) => {
        if (
          ref.repository !== repository ||
          !commits.has(ref.commit) ||
          createHash('sha256').update(bytes).digest('hex') !== ref.digest
        )
          throw new Error('Repository file does not match declared native facts')
        return [`${ref.repository}\0${ref.commit}\0${ref.path}`, { ref, bytes }] as const
      }),
    )
    if (repositoryFiles.size !== (input.repositoryFiles ?? []).length)
      throw new Error('Duplicate declared repository files')
    if (
      commits.size !== input.commits.length ||
      pulls.size !== input.pullRequests.length ||
      comparisons.size !== input.comparisons.length
    )
      throw new Error('Duplicate declared native facts')
    const diffs = new Map(input.diffs.map((diff) => [`${diff.base}\0${diff.head}`, diff.bytes]))
    if (diffs.size !== input.diffs.length) throw new Error('Duplicate declared code diffs')
    const transport = createNativeImplementationTransport({
      repository,
      ...(input.originUrl === undefined ? {} : { originUrl: input.originUrl }),
      ...(input.epic === undefined ? {} : { epic: input.epic }),
      ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
      author: input.author,
      histories: input.histories,
      graph: input.graph,
      commits,
      pulls,
      comparisons,
    })
    const { gh } = transport
    const declared = declaredNativeGit(commits, input.checkout)
    const { checkout } = declared
    const realGit = defaultGit()
    const git: GitRunner = async (workingDirectory, args) =>
      (args.length === 2 && args[0] === 'rev-parse' && args[1] === '--show-toplevel') ||
      (args.length === 3 && args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') ||
      (args.length === 2 && args[0] === 'show' && args[1] === 'HEAD:.dev/stack.yml') ||
      (args.length === 3 && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin')
        ? realGit(workingDirectory, args)
        : declared.git(workingDirectory, args)
    const at = async (directory: string, selectedGit: GitRunner): Promise<NativeWorld> => {
      const installed = await createInstalledUwOperations({
        cwd: directory,
        artifactsDir,
        gh,
        readAuthor: input.author,
        operator: input.operator ?? {
          async executeConfirmed() {
            throw new Error('No operator mutation is authorized')
          },
        },
      })
      const ports = nativeActionFixturePorts({
        cwd: directory,
        artifactsDir,
        gh,
        git: selectedGit,
        author: input.author,
        plugin: input.plugin,
        commits,
        diffs,
        repositoryFiles,
      })
      const operations = {
        ...installed,
        prepareAction: (
          request: Parameters<typeof installed.prepareAction>[0],
          projection?: Parameters<typeof installed.prepareAction>[1],
          review?: Parameters<typeof installed.prepareAction>[2],
        ) => prepareUwAction(request, ports, projection, review),
        replayActionInputs: (request: Parameters<typeof installed.replayActionInputs>[0]) =>
          replayUwActionInputs(request, ports),
      }
      return {
        cwd: directory,
        gh,
        ghSync: transport.ghSync,
        git: selectedGit,
        operations,
        checkout,
        observeGraph: transport.observeGraph,
        observePullRequest: transport.observePullRequest,
        editComment: transport.editComment,
        at: (next) => at(next, realGit),
      }
    }
    return await use(await at(cwd, git))
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true })
    if (owned) rmSync(cwd, { recursive: true, force: true })
  }
}

/** Run one implementation in the same persistent world used by multi-stage scenarios. */
export async function nativeImplementationWorld(input: NativeImplementationInput) {
  return arrangeNativeImplementation(input, withNativeImplementationWorld)
}
