import { describe, expect, it } from 'vitest'
import { parseEpicEvent } from './epic-events'
import { RUN, sha } from './epic-transition.fixture'

describe('canonical Epic events', () => {
  it('decodes a historical Epic fix for diagnostics and refuses the retired body marker', () => {
    expect(parseEpicEvent({ event: 'epic-fix', run: RUN })).toEqual({ event: 'epic-fix', run: RUN })
    expect(parseEpicEvent('<!-- omp-build:epic-fix run=run00001 -->')).toBeNull()
  })

  it('requires final review records to bind their exact range and authorities', () => {
    expect(
      parseEpicEvent({
        event: 'epic-review',
        run: RUN,
        range: `${sha('a')}..${sha('b')}`,
        decisionId: 'decision-1',
        inventoryIds: ['root-1', 'synthesis-1'],
        dispositionIds: [],
      }),
    ).toMatchObject({ event: 'epic-review', decisionId: 'decision-1' })
    expect(
      parseEpicEvent({
        event: 'epic-review',
        run: RUN,
        range: `${sha('a')}..${sha('b')}`,
        decisionId: 'decision-1',
        inventoryIds: ['root-1', 'synthesis-1'],
      }),
    ).toBeNull()
    expect(
      parseEpicEvent({ event: 'epic-review', run: RUN, range: 'main..head', decisionId: '', inventoryIds: [] }),
    ).toBeNull()
  })
})
