import { describe, expect, it } from 'vitest';
import {
  QORTAL_LAND_OPTIMIZED_ASSET_DIMENSIONS,
  qortalLandOptimizedAssetRenderScale,
} from './qortalLandOptimizedAssets';

describe('Qortal Land optimized assets', () => {
  it('keeps the original world dimensions after rendering a resized WebP', () => {
    for (const [assetId, dimensions] of Object.entries(
      QORTAL_LAND_OPTIMIZED_ASSET_DIMENSIONS
    )) {
      const renderScale = qortalLandOptimizedAssetRenderScale(assetId);
      expect(dimensions.optimizedWidth * renderScale.x).toBeCloseTo(
        dimensions.sourceWidth,
        8
      );
      expect(dimensions.optimizedHeight * renderScale.y).toBeCloseTo(
        dimensions.sourceHeight,
        8
      );
      expect(dimensions.optimizedWidth).toBeLessThan(dimensions.sourceWidth);
      expect(dimensions.optimizedHeight).toBeLessThan(dimensions.sourceHeight);
    }
  });

  it('does not compensate assets without an optimized counterpart', () => {
    expect(
      qortalLandOptimizedAssetRenderScale('architecture/club_floor')
    ).toEqual({
      x: 1,
      y: 1,
    });
  });
});
