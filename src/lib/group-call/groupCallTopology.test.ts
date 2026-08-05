import { describe, expect, it } from 'vitest';
import {
  buildGroupCallTopology,
  getReticulumTransportTargets,
  isResolvedGroupCallParticipantAddress,
} from './groupCallTopology';

describe('group-call topology participant identities', () => {
  it('does not treat unresolved transport sentinels as participants', () => {
    expect(isResolvedGroupCallParticipantAddress('unknown')).toBe(false);
    expect(isResolvedGroupCallParticipantAddress(' UNKNOWN ')).toBe(false);
    expect(isResolvedGroupCallParticipantAddress('')).toBe(false);
    expect(isResolvedGroupCallParticipantAddress('Q-peer')).toBe(true);
  });

  it('does not elect or route audio to an unresolved transport sentinel', () => {
    const topology = buildGroupCallTopology(['Q-root', 'unknown', 'Q-peer'], 1);

    expect(topology.clusters[0]?.members).toEqual(['Q-root', 'Q-peer']);
    expect(getReticulumTransportTargets('Q-root', topology)).toEqual([
      'Q-peer',
    ]);
  });

  it('filters an unresolved sentinel from a topology received from a peer', () => {
    const targets = getReticulumTransportTargets('Q-root', {
      topologyEpoch: 4,
      rootForwarder: 'Q-root',
      standbyForwarder: 'unknown',
      clusters: [
        {
          members: ['Q-root', 'Q-peer', 'unknown'],
          forwarder: 'Q-root',
          standby: 'Q-peer',
          standby2: 'unknown',
        },
      ],
    });

    expect(targets).toEqual(['Q-peer']);
  });
});
