#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import type { State } from '../skills/feature/testing/gh-simulator/sim-types.ts'

const args = process.argv.slice(2)
const statePath = process.env.GH_SIM_STATE
if (!statePath) throw new Error('fixture-gh-state-missing')
const endpoint = args.find((arg) => arg.startsWith('repos/acme/app/issues'))
const field = (key: string) => args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1)
const issuePath = endpoint?.match(/^repos\/acme\/app\/issues\/(\d+)$/)
const create = args[0] === 'api' && args.includes('POST') && endpoint === 'repos/acme/app/issues'
const patch = args[0] === 'api' && args.includes('PATCH') && issuePath !== undefined && issuePath !== null
const labels = args[0] === 'issue' && args[1] === 'edit'
if (create || patch || labels) {
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as State
  if (create) {
    const number = Math.max(0, ...Object.values(state.issues).map((issue) => issue.number)) + 1
    state.issues[String(number)] = {
      number,
      title: field('title') ?? '',
      body: field('body') ?? '',
      state: 'OPEN',
      author: state.viewer,
      labels: [],
      comments: [],
      subIssues: [],
      blockedBy: [],
      updatedAt: '2026-10-27T12:00:00Z',
    }
    writeFileSync(statePath, JSON.stringify(state))
    console.log(number)
  } else {
    const number = labels ? args[2] : issuePath?.[1]
    const issue = number === undefined ? undefined : state.issues[number]
    if (!issue) throw new Error('fixture-framing-issue-missing')
    if (patch) {
      issue.title = field('title') ?? issue.title
      issue.body = field('body') ?? issue.body
    } else {
      const values = (flag: string) => {
        const index = args.indexOf(flag)
        return index < 0 ? [] : (args[index + 1] ?? '').split(',')
      }
      const remove = values('--remove-label')
      issue.labels = [
        ...new Set([...issue.labels.filter((label) => !remove.includes(label)), ...values('--add-label')]),
      ]
    }
    writeFileSync(statePath, JSON.stringify(state))
    console.log('{}')
  }
  process.exit(0)
}
const pinGh = process.env.OMP_TEST_PIN_GH_PATH
if (!pinGh) throw new Error('fixture-pin-gh-missing')
const delegated = spawnSync(pinGh, args, {
  stdio: 'inherit',
  env: process.env,
})
process.exit(delegated.status ?? 1)
