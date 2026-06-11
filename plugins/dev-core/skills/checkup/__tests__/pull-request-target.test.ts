import { describe, expect, it } from 'vitest'
import { detectPullRequestTargetCheckout } from '../doctor-local'

/**
 * pull_request_target footgun detection.
 * The trigger runs with secrets + write token on the base repo; checking out
 * PR-head code in that context hands both to the PR author.
 */

describe('detectPullRequestTargetCheckout', () => {
  it('returns null when the trigger is absent', () => {
    const wf = [
      'on:',
      '  pull_request:',
      '    types: [opened]',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v4',
    ].join('\n')
    expect(detectPullRequestTargetCheckout(wf, 'ci.yml')).toBeNull()
  })

  it('flags none when trigger present but no checkout (API-only workflow)', () => {
    const wf = [
      'on:',
      '  pull_request_target:',
      '    types: [opened, reopened]',
      'jobs:',
      '  label:',
      '    steps:',
      '      - uses: dependabot/fetch-metadata@v2',
    ].join('\n')
    expect(detectPullRequestTargetCheckout(wf, 'automerge.yml')).toEqual({ file: 'automerge.yml', checkout: 'none' })
  })

  it('flags default when trigger present with checkout of base ref', () => {
    const wf = [
      'on:',
      '  pull_request_target:',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v4',
    ].join('\n')
    expect(detectPullRequestTargetCheckout(wf, 'wf.yml')).toEqual({ file: 'wf.yml', checkout: 'default' })
  })

  it('flags pr-head when checkout uses github.event.pull_request.head.sha', () => {
    const wf = [
      'on:',
      '  pull_request_target:',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax — intentionally a plain string
      '          ref: ${{ github.event.pull_request.head.sha }}',
    ].join('\n')
    expect(detectPullRequestTargetCheckout(wf, 'wf.yml')).toEqual({ file: 'wf.yml', checkout: 'pr-head' })
  })

  it('flags pr-head when checkout uses github.head_ref', () => {
    const wf = [
      'on:',
      '  pull_request_target:',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax — intentionally a plain string
      '          ref: ${{ github.head_ref }}',
    ].join('\n')
    expect(detectPullRequestTargetCheckout(wf, 'wf.yml')).toEqual({ file: 'wf.yml', checkout: 'pr-head' })
  })

  it('detects the trigger in inline on: array form', () => {
    const wf = ['on: [push, pull_request_target]', 'jobs:', '  build:', '    steps:', '      - run: echo ok'].join('\n')
    expect(detectPullRequestTargetCheckout(wf, 'wf.yml')).toEqual({ file: 'wf.yml', checkout: 'none' })
  })

  it('does not confuse pull_request with pull_request_target', () => {
    const wf = ['on: [pull_request]', 'jobs:', '  build:', '    steps:', '      - uses: actions/checkout@v4'].join('\n')
    expect(detectPullRequestTargetCheckout(wf, 'wf.yml')).toBeNull()
  })

  it('detects the trigger in flow-map form on: { pull_request_target: ... }', () => {
    const wf = [
      'on: { pull_request_target: { types: [opened] } }',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v4',
    ].join('\n')
    expect(detectPullRequestTargetCheckout(wf, 'wf.yml')).toEqual({ file: 'wf.yml', checkout: 'default' })
  })

  it('flags pr-head when the fork repo is checked out via repository:', () => {
    const wf = [
      'on:',
      '  pull_request_target:',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax — intentionally a plain string
      '          repository: ${{ github.event.pull_request.head.repo.full_name }}',
    ].join('\n')
    expect(detectPullRequestTargetCheckout(wf, 'wf.yml')).toEqual({ file: 'wf.yml', checkout: 'pr-head' })
  })

  it('flags pr-head when checkout uses the synthetic refs/pull/N/merge ref', () => {
    const wf = [
      'on:',
      '  pull_request_target:',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax — intentionally a plain string
      '          ref: refs/pull/${{ github.event.pull_request.number }}/merge',
    ].join('\n')
    expect(detectPullRequestTargetCheckout(wf, 'wf.yml')).toEqual({ file: 'wf.yml', checkout: 'pr-head' })
  })

  it('flags pr-head when PR code is fetched via a run: step, even without actions/checkout', () => {
    const wf = [
      'on:',
      '  pull_request_target:',
      'jobs:',
      '  build:',
      '    steps:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax — intentionally a plain string
      '      - run: git fetch origin pull/${{ github.event.pull_request.number }}/head:pr && git checkout pr',
    ].join('\n')
    expect(detectPullRequestTargetCheckout(wf, 'wf.yml')).toEqual({ file: 'wf.yml', checkout: 'pr-head' })
  })
})
