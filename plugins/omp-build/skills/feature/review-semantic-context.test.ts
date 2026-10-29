/**
 * The shared semantic slot. The model prompt and `hashReviewInput` must use
 * this exact string; pause, resume, and control stay out of it.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { confirmedReviewSemanticContext, reviewSemanticCanon } from '../../roxabi/review-semantic-canon'

function digest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

const body = 'accepted spec'
const bodyDigest = digest(body)

describe('reviewSemanticCanon', () => {
  it('encodes a complete no-tracker review as an explicit null, not an omitted field', () => {
    expect(reviewSemanticCanon({ mode: 'standalone', discoveredSpec: null })).toBe(JSON.stringify(['standalone', null]))
  })

  it('encodes a discovered spec as raw reference, body, and digest', () => {
    const projected = confirmedReviewSemanticContext({
      mode: 'standalone',
      binding: null,
      acceptedSpec: null,
      currentSpec: { reference: 'acme/app#9', body, digest: bodyDigest },
      effectiveConfig: null,
      additionalRequirements: [],
    })
    expect(projected).toEqual({
      mode: 'standalone',
      discoveredSpec: { reference: 'acme/app#9', body, digest: bodyDigest },
    })
    if ('ok' in projected) return
    expect(reviewSemanticCanon(projected)).toBe(JSON.stringify(['standalone', 'acme/app#9', body, bodyDigest]))
  })

  it('refuses a missing digest instead of inventing one', () => {
    expect(
      confirmedReviewSemanticContext({
        mode: 'standalone',
        binding: null,
        acceptedSpec: null,
        currentSpec: { reference: 'acme/app#9', body },
        effectiveConfig: null,
      }),
    ).toMatchObject({ ok: false, reason: 'unreadable', error: expect.stringMatching(/digest is missing/) })
  })

  it('refuses a chain item presented as a source ref', () => {
    expect(
      confirmedReviewSemanticContext({
        mode: 'bound',
        binding: { recordId: 'bind-1', scope: { repository: 'acme/app', target: 'acme/app#12' } },
        acceptedSpec: {
          reference: 'acme/app#9',
          body,
          digest: bodyDigest,
          chain: [
            {
              kind: 'mandate',
              source: {
                recordId: 'm1',
                scope: { repository: 'acme/app', target: 'acme/app#9' },
                kind: 'mandate',
              },
              version: bodyDigest,
            },
          ],
          sourceRefs: [
            {
              kind: 'mandate',
              recordId: 'm1',
              scope: { repository: 'acme/app', target: 'acme/app#9' },
              specDigest: bodyDigest,
            },
          ],
        },
        additionalRequirements: ['keep the gate'],
        effectiveConfig: { productVersion: '1.0.0', version: 'v1', digest: 'a'.repeat(64), serialized: '{}' },
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/external record identity/) })
  })

  it('places the accepted body and requirements as raw strings, and source refs as identity tuples', () => {
    const projected = confirmedReviewSemanticContext({
      mode: 'bound',
      binding: { recordId: 'bind-1', scope: { repository: 'acme/app', target: 'acme/app#12' } },
      acceptedSpec: {
        reference: 'acme/app#9',
        body,
        digest: bodyDigest,
        chain: [
          {
            kind: 'mandate',
            source: {
              recordId: 'm1',
              scope: { repository: 'acme/app', target: 'acme/app#9' },
              kind: 'mandate',
            },
            version: bodyDigest,
          },
        ],
        sourceRefs: [{ scope: { repository: 'acme/app', target: 'acme/app#9' }, recordId: 'm1', kind: 'mandate' }],
      },
      additionalRequirements: ['keep the gate'],
      effectiveConfig: { productVersion: '1.0.0', version: 'v1', digest: 'a'.repeat(64), serialized: '{}' },
    })
    expect('ok' in projected).toBe(false)
    if ('ok' in projected) return
    const canon = reviewSemanticCanon(projected)
    expect(canon).toBe(
      JSON.stringify([
        'bound',
        'bind-1',
        'acme/app',
        'acme/app#12',
        'acme/app#9',
        body,
        bodyDigest,
        [['mandate', 'm1', 'acme/app', 'acme/app#9', bodyDigest]],
        [['acme/app', 'acme/app#9', 'm1', 'mandate']],
        ['keep the gate'],
        '1.0.0',
        'v1',
        'a'.repeat(64),
        '{}',
      ]),
    )
    expect(reviewSemanticCanon(projected)).toContain('bound')
  })
})

describe('no-producer semantic binding', () => {
  const repository = 'acme/app'

  function bound(spec: string, serialized: string) {
    const projected = confirmedReviewSemanticContext({
      mode: 'bound',
      binding: { recordId: 'bind-1', scope: { repository, target: `${repository}#7` } },
      acceptedSpec: {
        reference: `${repository}#42`,
        body: spec,
        digest: digest(spec),
        chain: [
          {
            kind: 'mandate',
            source: {
              recordId: 'm1',
              scope: { repository, target: `${repository}#42` },
              kind: 'mandate',
            },
            version: digest(spec),
          },
        ],
        sourceRefs: [{ scope: { repository, target: `${repository}#42` }, recordId: 'm1', kind: 'mandate' }],
      },
      additionalRequirements: ['keep the gate'],
      effectiveConfig: { productVersion: '1.0.0', version: 'v1', digest: 'a'.repeat(64), serialized },
    })
    if ('ok' in projected) throw new Error(projected.error)
    return projected
  }

  it('changes the display canon when the accepted Spec or config changes', () => {
    const current = bound('accepted spec', '{}')
    const changed = bound('changed spec', '{}')
    const configured = bound('accepted spec', '{"gate":true}')
    expect(reviewSemanticCanon(current)).not.toBe(reviewSemanticCanon(changed))
    expect(reviewSemanticCanon(current)).not.toBe(reviewSemanticCanon(configured))
  })
})
