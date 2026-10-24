import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { epicMarkFix, epicStep } from '../skills/feature/epic-driver.ts'
import { triageCli, triageDirectory } from '../triage-runtime.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type History, type HistoryRecord, isRecord } from './feature-engine.ts'

const execFileAsync = promisify(execFile)

export async function runEpicPostMergeHook(cwd: string, epic: number): Promise<void> {
  const driver = fileURLToPath(new URL('../skills/feature/epic-driver.ts', import.meta.url))
  if (!existsSync(driver)) throw new Error('epic-driver-unavailable')
  const directory = mkdtempSync(join(tmpdir(), 'omp-build-epic-hook-'))
  try {
    await execFileAsync(
      'bun',
      ['--no-env-file', '--no-install', driver, 'hook', '--epic', String(epic), '--repo', cwd],
      {
        cwd: directory,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      },
    )
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // The hook failure remains authoritative; cleanup cannot mask it.
    }
  }
}

export async function fileEpicFixTicket(cwd: string, epic: number, history: History): Promise<ContinueFeatureResult> {
  const due = await epicFixTicketDue(cwd, epic)
  if (due !== null) return due
  const decision = latestEpicDecision(history)
  if (decision === null) return { kind: 'blocked', reason: 'epic-fix-source-decision-missing' }
  if (!existsSync(triageCli)) return { kind: 'blocked', reason: 'issue-triage-unavailable' }
  return fileEpicFixTicketThroughTriage(cwd, epic, history, decision.recordId, decision.payload.judgment)
}

async function epicFixTicketDue(cwd: string, epic: number): Promise<ContinueFeatureResult | null> {
  try {
    const step = await epicStep(cwd, epic)
    return step.step.action === 'final-review' && step.step.stage === 'fix-ticket'
      ? null
      : { kind: 'blocked', reason: 'epic-fix-ticket-not-due' }
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : 'epic-fix-ticket-unreadable' }
  }
}

function latestEpicDecision(history: History): Extract<HistoryRecord, { kind: 'decision' }> | null {
  for (const operation of [...history.operations].reverse()) {
    if (operation.record?.kind === 'decision') return operation.record
  }
  return null
}

async function fileEpicFixTicketThroughTriage(
  cwd: string,
  epic: number,
  history: History,
  decisionId: string,
  judgment: unknown,
): Promise<ContinueFeatureResult> {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'omp-build-epic-fix-'))
  try {
    const titleFile = join(directory, 'title.txt')
    const bodyFile = join(directory, 'body.md')
    writeFileSync(titleFile, epicFixTitle(judgment, epic))
    writeFileSync(bodyFile, epicFixBody(epic, decisionId))
    const created = await execFileAsync(
      'bun',
      [
        '--no-env-file',
        triageCli,
        'create',
        '--title-file',
        titleFile,
        '--body-file',
        bodyFile,
        '--type',
        'fix',
        '--size',
        's',
        '--parent',
        `#${epic}`,
      ],
      {
        cwd: triageDirectory,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_REPO: history.source.scope.repository },
        maxBuffer: 8 * 1024 * 1024,
      },
    )
    return confirmEpicFixTicket(cwd, epic, created.stdout)
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : 'epic-fix-ticket-failed' }
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
}

function epicFixTitle(judgment: unknown, epic: number): string {
  const summary = isRecord(judgment) && typeof judgment.summary === 'string' ? judgment.summary.trim() : ''
  return summary.length > 0 ? summary.slice(0, 80) : `Fix epic #${epic} blocking findings`
}

function epicFixBody(epic: number, decisionId: string): string {
  return [
    `Parent: #${epic}`,
    '',
    `Source decision: ${decisionId}`,
    '',
    'Filed through the trusted issue-triage path for the Epic fix-ticket stage.',
  ].join('\n')
}

async function confirmEpicFixTicket(cwd: string, epic: number, output: string): Promise<ContinueFeatureResult> {
  const match = /(?:^|\n)Created #([1-9][0-9]*)\b/m.exec(output)
  if (!match) return { kind: 'blocked', reason: 'issue-triage-create-unconfirmed' }
  const ticket = Number(match[1])
  await epicMarkFix(cwd, epic, ticket)
  return { kind: 'terminal', reason: `epic-fix-marked:#${ticket}` }
}
