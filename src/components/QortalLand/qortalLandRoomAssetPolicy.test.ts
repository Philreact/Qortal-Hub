import { describe, expect, it } from 'vitest';
import { collectQortalLandRoomAssetIds } from './qortalLandRoomAssetPolicy';

type RoomId = 'club' | 'skywalk' | 'mall' | 'park';

const placements = [
  { assetId: 'club/bar' },
  { assetId: 'club/shared-default' },
  { assetId: 'park/fountain', roomIds: ['park'] as const },
  { assetId: 'shared/sign', roomIds: ['club', 'park'] as const },
];

const select = (roomId: RoomId) =>
  collectQortalLandRoomAssetIds<RoomId>({
    roomId,
    defaultRoomId: 'club',
    placements,
    extraAssetIdsByRoom: {
      club: ['club/shell', 'club/bar'],
      park: ['park/floor', 'park/portal'],
    },
  });

describe('Qortal Land room asset policy', () => {
  it('loads only the starting room placements and required extras', () => {
    expect(select('park')).toEqual([
      'park/fountain',
      'shared/sign',
      'park/floor',
      'park/portal',
    ]);
  });

  it('defaults unscoped placements to the default room and removes duplicates', () => {
    expect(select('club')).toEqual([
      'club/bar',
      'club/shared-default',
      'shared/sign',
      'club/shell',
    ]);
  });

  it('returns no assets for a procedural room without placements or extras', () => {
    expect(select('skywalk')).toEqual([]);
    expect(select('mall')).toEqual([]);
  });
});
