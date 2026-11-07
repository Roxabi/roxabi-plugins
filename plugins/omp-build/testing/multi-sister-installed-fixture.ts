import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { nativeComment } from '../adapters/__tests__/github-workflow-support.ts'
import type { Gh } from '../adapters/github/types.ts'
import { createOperatorConfirmation } from '../omp/omp-operator-confirmation.ts'
import { createInstalledUwOperations, type InstalledUwOperationsOptions } from '../roxabi/uw-installed-operations.ts'
import { encodeCriterionRecords } from './criterion-approval.ts'
import { multiSisterFixture } from './multi-sister-fixture.ts'
import { type NativeIssue, sisterGraphTransport, sisterIssueTransport } from './multi-sister-graph-fixture.ts'
import { sisterNativeGitRequest } from './multi-sister-native-git.ts'
import { sisterImplementationHistory } from './multi-sister-plan-fixture.ts'
import { sisterCurrentPull, sisterDeclaredPull } from './multi-sister-pull-fixture.ts'
import { declaredNativeGit } from './native-declared-git.ts'
import type { DeclaredCheckout, NativeWorldFacts, nativeImplementationWorld } from './native-implementation-world.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from './roxabi-presets.ts'

const artifacts = mkdtempSync(join(tmpdir(), 'omp-sister-protocol-'))
process.once('exit', () => rmSync(artifacts, { recursive: true, force: true }))

/** Installed operations with a stateful GitHub transport; all records are encoded and read back. */
export async function installedMultiSisterFixture(
  count: 1 | 2 = 2,
  options: (
    | { workflow?: false; currentPr?: number; head?: string; base?: string; report?: boolean }
    | {
        workflow: true
        currentPr: number
        head: string
        base: string
        report?: boolean
        commits: Parameters<typeof nativeImplementationWorld>[0]['commits']
      }
  ) & {
    composedParent?: boolean
    cwd?: string
    pluginPin?: InstalledUwOperationsOptions['pluginPin']
    artifactsDir?: string | null
    nativeHost?: InstalledUwOperationsOptions['nativeHost']
    confirm?: (title: string, detail: string) => Promise<boolean>
    afterParentRelation?: (parent: number, child: number) => void
  } = {},
) {
  const data = multiSisterFixture(count, options.report ? 'report' : 'sister-blocking', options.composedParent ?? false)
  const head = options.head ?? 'a'.repeat(40)
  const base = options.base ?? 'b'.repeat(40)
  let prior = data.own
  if (options.workflow) prior = await sisterImplementationHistory(data, base, head, options.commits)
  const own = encodeCriterionRecords(
    data.dispositions,
    data.context.original,
    roxabiRecordFixtures().projection,
    'automation',
    [data.source, ...(data.parent === null ? [] : [data.parent.history])],
    prior,
  ).history
  const comments = new Map<number, ReturnType<typeof nativeComment>[]>([
    [42, own.source.comments.map((item, index) => nativeComment(index + 1, item.body))],
    [44, data.source.source.comments.map((item, index) => nativeComment(100 + index, item.body))],
  ])
  if (data.parent !== null)
    comments.set(
      41,
      data.parent.history.source.comments.map((item, index) => nativeComment(500 + index, item.body)),
    )
  const currentPr = options.currentPr ?? 44
  const currentScope = { repository: 'acme/app', target: `acme/app#${currentPr}` }
  const currentBinding = roxabiWorkflowFixtures().workflowBinding(currentScope, data.mandate, 'feat/42-save', 'main')
  if (currentPr !== 44) {
    const encoded = encodeCriterionRecords(
      [currentBinding],
      currentScope,
      roxabiRecordFixtures().projection,
      'automation',
      [own],
    )
    comments.set(
      currentPr,
      encoded.history.source.comments.map((item, index) => nativeComment(300 + index, item.body)),
    )
  }
  const issues = new Map<number, NativeIssue>([
    [
      42,
      {
        title: 'Original',
        body: data.body,
        labels: ['size:S'],
        parent: data.parent === null ? null : 41,
        blockers: [],
        state: 'OPEN',
        stateReason: null,
      },
    ],
  ])
  if (data.parent !== null)
    issues.set(41, {
      title: 'Parent',
      body: data.parent.body,
      labels: ['size:F-lite'],
      parent: null,
      blockers: [],
      state: 'OPEN',
      stateReason: null,
    })
  let nextIssue = 43
  let commentId = 200
  let confirmations = 0
  let linked = true
  let failedCheck = 'unit'
  let delivery: {
    commits: Map<string, NativeWorldFacts['commits'][number]>
    comparisons: Map<string, NativeWorldFacts['comparisons'][number]>
    pulls: Map<string, NativeWorldFacts['pullRequests'][number]>
  } | null = null
  const blobOid = createHash('sha1')
    .update(`blob ${data.catalogueBytes.length}\0`)
    .update(data.catalogueBytes)
    .digest('hex')
  function commentRequest(args: string[], endpoint: string): string | null {
    const match = /issues\/(\d+)\/comments/.exec(endpoint)
    if (!match) return null
    const number = Number(match[1])
    const list = comments.get(number)
    if (!list) throw new Error(`unknown history ${number}`)
    if (!args.includes('POST')) {
      const page = /[?&]page=(\d+)/.exec(endpoint)
      const offset = page ? (Number(page[1]) - 1) * 100 : 0
      return JSON.stringify(list.slice(offset, offset + 100))
    }
    const body = args.find((arg) => arg.startsWith('body='))?.slice(5)
    if (body === undefined) throw new Error('missing comment body')
    const item = nativeComment(++commentId, body)
    list.push(item)
    return JSON.stringify(item)
  }
  function createIssue(args: string[]): string {
    if (nextIssue === 44) nextIssue += 1
    const number = nextIssue++
    issues.set(number, {
      title: args.find((arg) => arg.startsWith('title='))?.slice(6) ?? '',
      body: args.find((arg) => arg.startsWith('body='))?.slice(5) ?? '',
      labels: [],
      parent: null,
      blockers: [],
      state: 'OPEN',
      stateReason: null,
    })
    comments.set(number, [])
    return String(number)
  }
  const issueRequest = sisterIssueTransport(issues, createIssue)
  const graphRequest = sisterGraphTransport({
    issues,
    currentPr,
    head,
    base,
    blobOid,
    catalogueRef: data.catalogueRef,
    afterParentRelation: options.afterParentRelation,
    deliveryPulls: () => delivery?.pulls.values() ?? [],
    failedCheck: () => failedCheck,
    linked: () => linked,
  })
  function deliveryRequest(args: string[], endpoint: string): string | null {
    const gitResponse = sisterNativeGitRequest(endpoint, options.workflow ? options.commits : undefined, delivery)
    if (gitResponse !== null) return gitResponse
    const declaredPull = sisterDeclaredPull(args, delivery?.pulls)
    if (declaredPull !== null) return declaredPull
    if (endpoint === `repos/${data.catalogueRef.repository}/git/blobs/${blobOid}`)
      return JSON.stringify({
        sha: blobOid,
        encoding: 'base64',
        size: data.catalogueBytes.length,
        content: data.catalogueBytes.toString('base64'),
      })
    return sisterCurrentPull(args, currentPr, head, base)
  }
  const gh: Gh = async (_cwd, args) => {
    const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
    if (args[0] === 'api' && args[1] === 'user') return 'automation'
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'acme/app' })
    const deliveryResponse = deliveryRequest(args, endpoint)
    if (deliveryResponse !== null) return deliveryResponse
    const comment = commentRequest(args, endpoint)
    if (comment !== null) return comment
    const issue = issueRequest(args, endpoint)
    if (issue !== null) return issue
    if (args[1] === 'graphql') return graphRequest(args)
    throw new Error(`unexpected GitHub request: ${args.join(' ')}`)
  }
  const newCommand = async () => {
    const operator = createOperatorConfirmation({
      agent: { kind: 'main', depth: 0 },
      hasUI: true,
      mode: 'tui',
      ui: {
        confirm: async (title: string, detail: string) => {
          confirmations += 1
          return options.confirm ? options.confirm(title, detail) : true
        },
      },
      localProtocolOptions: { getArtifactsDir: () => options.artifactsDir ?? artifacts },
    } as unknown as ExtensionContext)
    return createInstalledUwOperations({
      cwd: options.cwd ?? '/fixture',
      gh,
      readAuthor: 'automation',
      operator,
      pluginPin: options.pluginPin,
      artifactsDir: options.artifactsDir,
      nativeHost: options.nativeHost,
    })
  }
  const operations = await newCommand()
  const request = (index: number) => ({
    disposition: {
      scope: data.context.original,
      recordId: data.dispositions[index].recordId,
      kind: 'cause-disposition' as const,
    },
    factors: { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
    tierOverride: null,
    labels: { add: [], remove: [] },
  })
  return {
    ...data,
    comments,
    issues,
    gh,
    declaredBase: base,
    declaredHead: head,
    originalCommits: options.workflow ? options.commits : null,
    declareDelivery(facts: Pick<NativeWorldFacts, 'commits' | 'comparisons'>, initial: DeclaredCheckout) {
      if (delivery !== null) throw new Error('Delivery facts are already declared')
      const commits = new Map(facts.commits.map((commit) => [commit.sha, commit]))
      const comparisons = new Map(
        facts.comparisons.map((comparison) => [`${comparison.base}\0${comparison.head}`, comparison]),
      )
      if (commits.size !== facts.commits.length || comparisons.size !== facts.comparisons.length)
        throw new Error('Duplicate native delivery facts')
      const git = declaredNativeGit(commits, initial)
      const pulls = new Map<string, NativeWorldFacts['pullRequests'][number]>()
      delivery = { commits, comparisons, pulls }
      return {
        ...git,
        observePullRequest(pull: NativeWorldFacts['pullRequests'][number]) {
          const number = Number(pull.scope.target.split('#')[1])
          if (
            pull.scope.repository !== 'acme/app' ||
            number === 44 ||
            number === currentPr ||
            !commits.has(pull.head) ||
            !commits.has(pull.baseTip) ||
            (pull.mergeCommit !== null && !commits.has(pull.mergeCommit))
          )
            throw new Error('Pull request refers to undeclared delivery facts')
          if (!comments.has(number)) comments.set(number, [])
          pulls.set(pull.scope.target, pull)
        },
      }
    },
    operations,
    newCommand,
    request,
    currentPr,
    currentBinding,
    setFailedCheck: (value: string) => {
      failedCheck = value
    },
    setLinked: (value: boolean) => {
      linked = value
    },
    confirmations: () => confirmations,
  }
}
