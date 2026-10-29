import { describe, expect, it } from 'vitest'
import { featurePullBody, generatedPullBody } from './generated-pr-body.js'

const CLOSING_KEYWORD = /\b(?:closed|closes|close|fixes|fixed|fix|resolved|resolves|resolve)\b/i

describe('generatedPullBody', () => {
  it('preserves every byte when no closing keyword is followed by a reference', () => {
    const source = '```js\n  const n = 1\n```\n\n- item  \nSee #5\nRefs #9\nfeat(api): images (#135)\n'
    expect(generatedPullBody(undefined)).toBe('')
    expect(generatedPullBody('')).toBe('')
    expect(generatedPullBody(source)).toBe(source)
    expect(generatedPullBody('See #5')).not.toMatch(/\bbinding\b/i)
  })

  it('replaces only the closing keyword and keeps the reference, list, and surrounding bytes', () => {
    const source = [
      '## Own spec',
      '',
      '  Deliver the criterion.',
      '',
      'Closes #5',
      'Fixes #1 and #2',
      'Resolves: #10, resolves #123, resolves octo-org/octo-repo#100',
      'CLOSES #7',
      'Fixes https://github.com/Roxabi/roxabi-plugins/issues/904',
      'Closes #10, go-silex/other#11',
      'Fixes https://evil.example/acme/app/issues/9',
      '',
      'See #12 for the follow-up. Refs #99.',
    ].join('\n')
    expect(generatedPullBody(source)).toBe(
      [
        '## Own spec',
        '',
        '  Deliver the criterion.',
        '',
        'References #5',
        'References #1 and #2',
        'References: #10, References #123, References octo-org/octo-repo#100',
        'References #7',
        'References https://github.com/Roxabi/roxabi-plugins/issues/904',
        'References #10, go-silex/other#11',
        'References https://evil.example/acme/app/issues/9',
        '',
        'See #12 for the follow-up. Refs #99.',
      ].join('\n'),
    )
  })

  it('treats a colon, whitespace, or newline between the keyword and the reference as the same directive', () => {
    expect(generatedPullBody('Please close\n#12 before release.')).toBe('Please References\n#12 before release.')
    expect(generatedPullBody('Closes\n\n#42')).toBe('References\n\n#42')
    expect(generatedPullBody('Fixes\nhttps://ghe.example.com:8443/acme/app/pull/3')).toBe(
      'References\nhttps://ghe.example.com:8443/acme/app/pull/3',
    )
    expect(generatedPullBody('Resolves: \n #10')).toBe('References: \n #10')
  })

  it('leaves a keyword that is not followed by a recognized reference', () => {
    expect(generatedPullBody('we will fix this after #99 lands')).toBe('we will fix this after #99 lands')
    expect(generatedPullBody('Fixed auth. See #88 for follow-up')).toBe('Fixed auth. See #88 for follow-up')
    expect(generatedPullBody('docs: mention fix for #12')).toBe('docs: mention fix for #12')
    expect(generatedPullBody('### Fixed\n- fix(api): resolve timeout (#43)')).toBe(
      '### Fixed\n- fix(api): resolve timeout (#43)',
    )
    expect(generatedPullBody('Fixes https://api.github.com/repos/acme/app/issues/9')).toBe(
      'Fixes https://api.github.com/repos/acme/app/issues/9',
    )
  })

  it('neutralizes a copied commit keyword in a promotion summary without rewriting the other summary bytes', () => {
    const summary = [
      '## Promotion: staging → main (v1.2.3)',
      '',
      '### Fixed',
      '- fix(api): resolve timeout (#43)',
      '',
      'Copied from 9f3a1c:',
      'Closes #42',
      'Fixes https://ghe.example.com/acme/app/issues/7',
      '',
    ].join('\n')
    const rendered = generatedPullBody(summary)
    expect(rendered).toBe(
      [
        '## Promotion: staging → main (v1.2.3)',
        '',
        '### Fixed',
        '- fix(api): resolve timeout (#43)',
        '',
        'Copied from 9f3a1c:',
        'References #42',
        'References https://ghe.example.com/acme/app/issues/7',
        '',
      ].join('\n'),
    )
    expect(rendered).not.toMatch(/^closes #\d+/im)
  })
})

describe('featurePullBody', () => {
  it('names the bound UW and does not keep a copied closing keyword as that reference', () => {
    expect(featurePullBody('Closes #99\nSee #12', 5)).toBe('References #99\nSee #12\n\nUW #5')
    expect(featurePullBody('', 5)).toBe('UW #5')
    expect(featurePullBody('UW #5', 5)).toBe('UW #5')
    expect(featurePullBody('Closes #5', 5)).toBe('References #5\n\nUW #5')
    expect(featurePullBody('Closes\n#99', 5)).toBe('References\n#99\n\nUW #5')
    expect(featurePullBody('See #12', 5)).not.toMatch(/\bbinding\b/i)
    expect(featurePullBody('See #12', 5)).not.toMatch(CLOSING_KEYWORD)
  })
})
