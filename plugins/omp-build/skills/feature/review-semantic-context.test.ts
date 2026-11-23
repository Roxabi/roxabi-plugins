import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { confirmedReviewSemanticContext } from '../../roxabi/review-semantic-canon'

function digest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

const body = 'accepted spec'
const bodyDigest = digest(body)

describe('confirmedReviewSemanticContext', () => {
  it('projects a complete no-tracker review with explicit null context', () => {
    expect(
      confirmedReviewSemanticContext({
        mode: 'standalone',
        binding: null,
        acceptedSpec: null,
        currentSpec: null,
        effectiveConfig: null,
      }),
    ).toEqual({ mode: 'standalone', discoveredSpec: null })
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

  it('preserves the accepted body, requirements, and source identities', () => {
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
    expect(projected).toMatchObject({
      mode: 'bound',
      bindingId: 'bind-1',
      scope: { repository: 'acme/app', target: 'acme/app#12' },
      acceptedSpec: { reference: 'acme/app#9', body, digest: bodyDigest },
      chain: [['mandate', 'm1', 'acme/app', 'acme/app#9', bodyDigest]],
      sourceRefs: [['acme/app', 'acme/app#9', 'm1', 'mandate']],
      requirements: ['keep the gate'],
      config: { productVersion: '1.0.0', version: 'v1', digest: 'a'.repeat(64), serialized: '{}' },
    })
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

  it('preserves changes to the accepted Spec and effective config', () => {
    const current = bound('accepted spec', '{}')
    const changed = bound('changed spec', '{}')
    const configured = bound('accepted spec', '{"gate":true}')
    expect(current).not.toEqual(changed)
    expect(current).not.toEqual(configured)
  })
})
