export type QortalLandOptimizedAssetDimensions = {
  sourceWidth: number;
  sourceHeight: number;
  optimizedWidth: number;
  optimizedHeight: number;
};

// These WebP files are intentionally sized near twice their largest rendered size.
// Keep the source PNGs alongside them as lossless masters and as a fallback.
export const QORTAL_LAND_OPTIMIZED_ASSET_DIMENSIONS: Readonly<
  Record<string, QortalLandOptimizedAssetDimensions>
> = {
  'architecture/park_portal_closed': {
    sourceWidth: 685,
    sourceHeight: 1099,
    optimizedWidth: 343,
    optimizedHeight: 550,
  },
  'architecture/park_portal_open_1': {
    sourceWidth: 685,
    sourceHeight: 1099,
    optimizedWidth: 343,
    optimizedHeight: 550,
  },
  'architecture/park_portal_open_2': {
    sourceWidth: 685,
    sourceHeight: 1099,
    optimizedWidth: 343,
    optimizedHeight: 550,
  },
  'architecture/park_portal_open_3': {
    sourceWidth: 685,
    sourceHeight: 1099,
    optimizedWidth: 343,
    optimizedHeight: 550,
  },
  'architecture/park_portal_open_4': {
    sourceWidth: 685,
    sourceHeight: 1099,
    optimizedWidth: 343,
    optimizedHeight: 550,
  },
  'decorations/park_bench_planter_left': {
    sourceWidth: 1515,
    sourceHeight: 787,
    optimizedWidth: 606,
    optimizedHeight: 315,
  },
  'decorations/park_fountain_blue': {
    sourceWidth: 1292,
    sourceHeight: 860,
    optimizedWidth: 516,
    optimizedHeight: 344,
  },
  'decorations/park_planter_corner_trees': {
    sourceWidth: 812,
    sourceHeight: 877,
    optimizedWidth: 650,
    optimizedHeight: 702,
  },
  'decorations/park_planter_row_trees': {
    sourceWidth: 1422,
    sourceHeight: 734,
    optimizedWidth: 569,
    optimizedHeight: 294,
  },
  'decorations/park_tree_planter_lamp': {
    sourceWidth: 1303,
    sourceHeight: 941,
    optimizedWidth: 521,
    optimizedHeight: 376,
  },
  'decorations/park_tree_round_large': {
    sourceWidth: 1066,
    sourceHeight: 794,
    optimizedWidth: 426,
    optimizedHeight: 318,
  },
  'decorations/park_tree_round_tall': {
    sourceWidth: 734,
    sourceHeight: 974,
    optimizedWidth: 294,
    optimizedHeight: 390,
  },
  'decorations/planter_rect_tropical': {
    sourceWidth: 1244,
    sourceHeight: 1094,
    optimizedWidth: 498,
    optimizedHeight: 438,
  },
  'decorations/planter_tall_tropical': {
    sourceWidth: 682,
    sourceHeight: 1353,
    optimizedWidth: 273,
    optimizedHeight: 541,
  },
  'furniture/bar_counter_long': {
    sourceWidth: 1536,
    sourceHeight: 1024,
    optimizedWidth: 1152,
    optimizedHeight: 768,
  },
  'furniture/bar_stool_round': {
    sourceWidth: 389,
    sourceHeight: 690,
    optimizedWidth: 128,
    optimizedHeight: 227,
  },
  'furniture/park_bench_curved': {
    sourceWidth: 1466,
    sourceHeight: 430,
    optimizedWidth: 650,
    optimizedHeight: 191,
  },
  'furniture/park_bench_straight': {
    sourceWidth: 1334,
    sourceHeight: 486,
    optimizedWidth: 534,
    optimizedHeight: 194,
  },
  'furniture/sofa_modern_a_purple': {
    sourceWidth: 1243,
    sourceHeight: 564,
    optimizedWidth: 497,
    optimizedHeight: 226,
  },
  'furniture/sofa_modern_a_teal': {
    sourceWidth: 1298,
    sourceHeight: 619,
    optimizedWidth: 519,
    optimizedHeight: 248,
  },
  'furniture/table_round_low': {
    sourceWidth: 840,
    sourceHeight: 553,
    optimizedWidth: 252,
    optimizedHeight: 166,
  },
  'technology/back_bar_unit_long': {
    sourceWidth: 1742,
    sourceHeight: 512,
    optimizedWidth: 1045,
    optimizedHeight: 307,
  },
  'technology/dj_booth': {
    sourceWidth: 1280,
    sourceHeight: 425,
    optimizedWidth: 384,
    optimizedHeight: 128,
  },
};

export const qortalLandOptimizedAssetRenderScale = (
  assetId: string
): { x: number; y: number } => {
  const dimensions = QORTAL_LAND_OPTIMIZED_ASSET_DIMENSIONS[assetId];
  if (!dimensions) return { x: 1, y: 1 };
  return {
    x: dimensions.sourceWidth / dimensions.optimizedWidth,
    y: dimensions.sourceHeight / dimensions.optimizedHeight,
  };
};
