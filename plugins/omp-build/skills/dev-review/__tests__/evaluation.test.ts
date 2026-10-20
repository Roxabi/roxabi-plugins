import { describe, expect, it, vi } from 'vitest'
import { evaluateFindings } from '../evaluation'

const choice = (value: string) => ({ type: 'choice' as const, choice: value })

describe('evaluateFindings', () => {
  it('retains TypeSafe dimensions and exposes a fallback item as degraded in the same batch', async () => {
    const drain = vi.fn().mockResolvedValue([
      [
        'F-supported',
        {
          key: 'F-supported',
          model: 'typesafe/jev-v1',
          answers: {
            evidenceSupport: choice('supported'),
            supportedApplicability: choice('applicable'),
            concreteConsequence: choice('concrete'),
            uncertainty: choice('known'),
          },
        },
      ],
      [
        'F-fallback',
        {
          key: 'F-fallback',
          model: 'fallback/reviewer-v1',
          answers: {
            evidenceSupport: choice('supported'),
            supportedApplicability: choice('applicable'),
            concreteConsequence: choice('concrete'),
            uncertainty: choice('known'),
          },
        },
      ],
    ])
    const status = vi.fn().mockResolvedValue({ running: false, done: 2 })
    const close = vi.fn().mockResolvedValue(undefined)
    const judgeBatch = vi.fn().mockResolvedValue({ drain, status, close })

    const result = await evaluateFindings(
      {
        'F-supported': {
          finding: 'The public route does not enforce the documented authorization check.',
          evidence: ['The route reaches the mutating handler without the guard.'],
        },
        'F-fallback': {
          finding: 'The cache is never invalidated after configuration changes.',
          evidence: ['The configuration update path does not touch the cache key.'],
        },
      },
      { judgeBatch },
    )

    expect(judgeBatch).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(result).toEqual({
      'F-supported': {
        status: 'observed',
        backend: 'typesafe/jev-v1',
        error: null,
        dimensions: {
          evidenceSupport: 'supported',
          supportedApplicability: 'applicable',
          concreteConsequence: 'concrete',
          uncertainty: 'known',
        },
      },
      'F-fallback': {
        status: 'degraded',
        reason: 'non-typesafe-backend',
        backend: 'fallback/reviewer-v1',
        error: null,
      },
    })
  })

  it('does not create a batch for empty findings', async () => {
    const judgeBatch = vi.fn()

    await expect(evaluateFindings({}, { judgeBatch })).resolves.toEqual({})
    expect(judgeBatch).not.toHaveBeenCalled()
  })

  it('preserves every ID when the batch fails before any item can be drained', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const judgeBatch = vi.fn().mockResolvedValue({
      drain: vi.fn().mockRejectedValue(new Error('judge backend unavailable')),
      status: vi.fn(),
      close,
    })

    const result = await evaluateFindings(
      {
        'F-first': { finding: 'First finding', evidence: [] },
        'F-second': { finding: 'Second finding', evidence: [] },
      },
      { judgeBatch },
    )

    expect(close).toHaveBeenCalledOnce()
    expect(result).toEqual({
      'F-first': {
        status: 'degraded',
        reason: 'drain-failed',
        backend: null,
        error: 'judge backend unavailable',
      },
      'F-second': {
        status: 'degraded',
        reason: 'drain-failed',
        backend: null,
        error: 'judge backend unavailable',
      },
    })
  })

  it('does not turn malformed TypeSafe answers or missing items into observations', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const judgeBatch = vi.fn().mockResolvedValue({
      drain: vi.fn().mockResolvedValue([
        [
          'F-malformed',
          {
            key: 'F-malformed',
            model: 'typesafe/jev-v1',
            answers: {
              evidenceSupport: choice('supported'),
              supportedApplicability: choice('applicable'),
              concreteConsequence: choice('concrete'),
              uncertainty: choice('certain'),
            },
          },
        ],
      ]),
      status: vi.fn().mockResolvedValue({ running: false, done: 1 }),
      close,
    })

    const result = await evaluateFindings(
      {
        'F-malformed': { finding: 'Malformed answer', evidence: [] },
        'F-missing': { finding: 'Missing result', evidence: [] },
      },
      { judgeBatch },
    )

    expect(result).toEqual({
      'F-malformed': {
        status: 'degraded',
        reason: 'invalid-answers',
        backend: 'typesafe/jev-v1',
        error: null,
      },
      'F-missing': {
        status: 'degraded',
        reason: 'missing-item',
        backend: null,
        error: null,
      },
    })
  })

  it('preserves every ID when creating the host batch fails', async () => {
    const judgeBatch = vi.fn().mockRejectedValue(new Error('judge host unavailable'))

    const result = await evaluateFindings(
      {
        'F-first': { finding: 'First finding', evidence: [] },
        'F-second': { finding: 'Second finding', evidence: [] },
      },
      { judgeBatch },
    )

    expect(result).toEqual({
      'F-first': {
        status: 'degraded',
        reason: 'batch-unavailable',
        backend: null,
        error: 'judge host unavailable',
      },
      'F-second': {
        status: 'degraded',
        reason: 'batch-unavailable',
        backend: null,
        error: 'judge host unavailable',
      },
    })
  })

  it('keeps item errors and malformed drain entries explicit without dropping findings', async () => {
    const judgeBatch = vi.fn().mockResolvedValue({
      drain: vi.fn().mockResolvedValue([
        [
          'F-item-error',
          {
            key: 'F-item-error',
            model: 'typesafe/jev-v1',
            error: 'response schema rejected',
          },
        ],
        { malformed: true },
      ]),
      status: vi.fn().mockResolvedValue({ running: false, done: 2 }),
      close: vi.fn().mockResolvedValue(undefined),
    })

    const result = await evaluateFindings(
      {
        'F-item-error': { finding: 'Item failure', evidence: [] },
        'F-drain-shape': { finding: 'Malformed pair', evidence: [] },
      },
      { judgeBatch },
    )

    expect(result).toEqual({
      'F-item-error': {
        status: 'degraded',
        reason: 'judgment-error',
        backend: 'typesafe/jev-v1',
        error: 'response schema rejected',
      },
      'F-drain-shape': {
        status: 'degraded',
        reason: 'invalid-drain-shape',
        backend: null,
        error: null,
      },
    })
  })

  it('preserves a native-accepted __proto__ finding ID as an own serializable observation', async () => {
    const specialId = '__proto__'
    const judgeBatch = vi.fn().mockResolvedValue({
      drain: vi.fn().mockResolvedValue([
        [
          specialId,
          {
            key: specialId,
            model: 'typesafe/jev-v1',
            answers: {
              evidenceSupport: choice('supported'),
              supportedApplicability: choice('applicable'),
              concreteConsequence: choice('concrete'),
              uncertainty: choice('known'),
            },
          },
        ],
      ]),
      status: vi.fn().mockResolvedValue({ running: false, done: 1 }),
      close: vi.fn().mockResolvedValue(undefined),
    })

    const result = await evaluateFindings(
      Object.fromEntries([
        [specialId, { finding: 'Native-accepted special ID', evidence: ['Observed by the supported host.'] }],
      ]),
      { judgeBatch },
    )
    const serialized = JSON.parse(JSON.stringify(result)) as Record<string, unknown>

    expect(Object.hasOwn(result, specialId)).toBe(true)
    expect(Object.keys(result)).toEqual([specialId])
    expect(Object.hasOwn(serialized, specialId)).toBe(true)
    expect(serialized[specialId]).toEqual({
      status: 'observed',
      backend: 'typesafe/jev-v1',
      error: null,
      dimensions: {
        evidenceSupport: 'supported',
        supportedApplicability: 'applicable',
        concreteConsequence: 'concrete',
        uncertainty: 'known',
      },
    })
  })

  it('preserves a missing native-accepted __proto__ finding ID as an own serializable degradation', async () => {
    const specialId = '__proto__'
    const judgeBatch = vi.fn().mockResolvedValue({
      drain: vi.fn().mockResolvedValue([]),
      status: vi.fn().mockResolvedValue({ running: false, done: 0 }),
      close: vi.fn().mockResolvedValue(undefined),
    })

    const result = await evaluateFindings(
      Object.fromEntries([[specialId, { finding: 'Missing native result', evidence: ['The host emitted no item.'] }]]),
      { judgeBatch },
    )
    const serialized = JSON.parse(JSON.stringify(result)) as Record<string, unknown>

    expect(Object.hasOwn(result, specialId)).toBe(true)
    expect(Object.keys(result)).toEqual([specialId])
    expect(Object.hasOwn(serialized, specialId)).toBe(true)
    expect(serialized[specialId]).toEqual({
      status: 'degraded',
      reason: 'missing-item',
      backend: null,
      error: null,
    })
  })
})
