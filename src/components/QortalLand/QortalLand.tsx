import SendRoundedIcon from '@mui/icons-material/SendRounded';
import { Box, Button, IconButton, MenuItem, TextField, Typography, useTheme } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import defaultCharacterSpritesheetUrl from '../../assets/qortalland/default-character-spritesheet.png';
import { getPrimaryNamesForAddresses } from '../Group/groupApi';

type LandPlayerState = {
  authorAddress: string;
  sessionId: string;
  sequence: number;
  roomId: LandRoomId;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  displayX: number;
  displayY: number;
  direction: string;
  movement: string;
  sentAt: number;
  receivedAt: number;
  lastSeenAt: number;
  interpolationMs: number;
  velocityX: number;
  velocityY: number;
};

type LocalLandState = {
  roomId: LandRoomId;
  x: number;
  y: number;
  direction: string;
  movement: string;
};

type LandChatBubble = {
  messageId: string;
  authorAddress: string;
  sessionId: string;
  sequence: number;
  text: string;
  createdAt: number;
  expiresAt: number;
};

type QortalLandProps = {
  groupId: number;
  groupName: string;
  myAddress: string;
};

const LAND_SEND_INTERVAL_MS = 125;
const LAND_HEARTBEAT_MS = 2000;
const LAND_REMOTE_TTL_MS = 30000;
const LAND_REMOTE_MIN_INTERPOLATION_MS = 220;
const LAND_REMOTE_MAX_INTERPOLATION_MS = 950;
const LAND_REMOTE_EXTRAPOLATE_MS = 1100;
const LAND_REMOTE_STOP_WALKING_AFTER_MS = 1450;
const LAND_REMOTE_MAX_VELOCITY_PX_PER_MS = 0.32;
const LAND_REMOTE_MAX_EXTRAPOLATE_DISTANCE = 180;
const LAND_CHAT_BUBBLE_TTL_MS = 15000;
const LAND_CHAT_MAX_TEXT_BYTES = 1024;
const LAND_CHAT_MAX_INPUT_CHARS = 420;
const QORTAL_LAND_CHANNEL_ID = 'qortal-land';
const LAND_CHARACTER_SPRITESHEET_KEY = 'qortalland-default-character';
const LAND_CHARACTER_IDLE_SIDE_ANIM_KEY = 'qortalland-default-character-idle-side';
const LAND_CHARACTER_WALK_SIDE_ANIM_KEY = 'qortalland-default-character-walk-side';
const LAND_CHARACTER_IDLE_DOWN_ANIM_KEY = 'qortalland-default-character-idle-down';
const LAND_CHARACTER_WALK_DOWN_ANIM_KEY = 'qortalland-default-character-walk-down';
const LAND_CHARACTER_IDLE_UP_ANIM_KEY = 'qortalland-default-character-idle-up';
const LAND_CHARACTER_WALK_UP_ANIM_KEY = 'qortalland-default-character-walk-up';
const LAND_CHARACTER_FRAME_SIZE = 320;
const LAND_CHARACTER_FRAMES_PER_DIRECTION = 7;
const LAND_CHARACTER_FEET_BASELINE = 292;
const LAND_CHARACTER_RENDER_SCALE = 0.56;
const LAND_CHARACTER_LABEL_OFFSET = 248;
const LAND_CHARACTER_CHAT_BUBBLE_OFFSET = 292;
type LandRoomId = 'club' | 'skywalk' | 'mall' | 'park';
const QORTAL_LAND_DEFAULT_ROOM_ID: LandRoomId = 'club';
const QORTAL_LAND_SKYWALK_ROOM_ID: LandRoomId = 'skywalk';
const QORTAL_LAND_MALL_ROOM_ID: LandRoomId = 'mall';
const QORTAL_LAND_PARK_ROOM_ID: LandRoomId = 'park';

type QortalLandRoomFloorLayout = {
  topY: number;
  bottomY: number;
  back: {
    minX: number;
    maxX: number;
  };
  front: {
    minX: number;
    maxX: number;
  };
};

type QortalLandRoomTransitionTarget = {
  roomId: LandRoomId;
  x: number;
  y: number;
  direction: string;
};

type QortalLandRoomLayout = {
  width: number;
  height: number;
  floor: QortalLandRoomFloorLayout;
  interactions?: {
    djBooth?: {
      x: number;
      y: number;
      promptY: number;
      radius: number;
      weightedXScale: number;
    };
  };
  transitions?: {
    clubToSkywalk?: {
      target: QortalLandRoomTransitionTarget;
    };
    skywalkToClubReturn?: {
      target: QortalLandRoomTransitionTarget;
    };
  };
};

const QORTAL_LAND_ROOM_LAYOUTS: Record<LandRoomId, QortalLandRoomLayout> = {
  [QORTAL_LAND_DEFAULT_ROOM_ID]: {
    width: 1800,
    height: 820,
    floor: {
      topY: 302,
      bottomY: 686,
      back: { minX: 273, maxX: 1523 },
      front: { minX: 87, maxX: 1709 },
    },
    interactions: {
      djBooth: {
        x: 900,
        y: 374,
        promptY: 280,
        radius: 148,
        weightedXScale: 0.74,
      },
    },
    transitions: {
      clubToSkywalk: {
        target: { roomId: QORTAL_LAND_SKYWALK_ROOM_ID, x: 220, y: 430, direction: 'r' },
      },
      skywalkToClubReturn: {
        target: { roomId: QORTAL_LAND_DEFAULT_ROOM_ID, x: 1495, y: 374, direction: 'd' },
      },
    },
  },
  [QORTAL_LAND_SKYWALK_ROOM_ID]: {
    width: 1800,
    height: 820,
    floor: {
      topY: 338,
      bottomY: 666,
      back: { minX: 128, maxX: 1672 },
      front: { minX: 150, maxX: 1650 },
    },
  },
  [QORTAL_LAND_MALL_ROOM_ID]: {
    width: 1800,
    height: 820,
    floor: {
      topY: 332,
      bottomY: 700,
      back: { minX: 150, maxX: 1650 },
      front: { minX: 70, maxX: 1730 },
    },
  },
  [QORTAL_LAND_PARK_ROOM_ID]: {
    width: 1800,
    height: 820,
    floor: {
      topY: 326,
      bottomY: 704,
      back: { minX: 110, maxX: 1690 },
      front: { minX: 24, maxX: 1776 },
    },
  },
};

const LAND_WIDTH = QORTAL_LAND_ROOM_LAYOUTS[QORTAL_LAND_DEFAULT_ROOM_ID].width;
const LAND_HEIGHT = QORTAL_LAND_ROOM_LAYOUTS[QORTAL_LAND_DEFAULT_ROOM_ID].height;
const QORTAL_LAND_DEV_PNG_ASSET_KEY_PREFIX = 'qortalland-dev-png';
const QORTAL_LAND_DEV_PNG_PROPS_STORAGE_KEY = 'qortalland.devPngProps';
const QORTAL_LAND_DEV_PROCEDURAL_CLUB_SHELL_STORAGE_KEY = 'qortalland.devProceduralClubShell';
const QORTAL_LAND_DEV_COLLISION_DEBUG_STORAGE_KEY = 'qortalland.devCollisionDebug';
const QORTAL_LAND_DEV_LOOK_STORAGE_KEY = 'qortalland.devLook';
const QORTAL_LAND_DEV_PNG_PLACEMENT_STORAGE_PREFIX = 'qortalland.devPlacement.';
const QORTAL_LAND_DEV_ASSETS_CHANGED_EVENT = 'qortalland:devAssetsChanged';
const QORTAL_LAND_DEVELOPMENT_CLUB_FLOOR_ASSET_ID = 'architecture/club_floor';
const QORTAL_LAND_DEVELOPMENT_CLUB_FLOOR_PLACEMENT_ID = 'club.floor_png';
const QORTAL_LAND_DEVELOPMENT_BACK_WALL_ASSET_ID = 'architecture/back_wall_main';
const QORTAL_LAND_DEVELOPMENT_BACK_WALL_PLACEMENT_ID = 'club.back_wall_main_png';
const QORTAL_LAND_DEVELOPMENT_LEFT_WALL_ASSET_ID = 'architecture/club_wall_left';
const QORTAL_LAND_DEVELOPMENT_LEFT_WALL_PLACEMENT_ID = 'club.wall_left_png';
const QORTAL_LAND_DEVELOPMENT_RIGHT_WALL_ASSET_ID = 'architecture/club_wall_right';
const QORTAL_LAND_DEVELOPMENT_RIGHT_WALL_PLACEMENT_ID = 'club.wall_right_png';
const QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_CLOSED_ASSET_ID = 'architecture/door_closed';
const QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_SEMI_OPEN_ASSET_ID = 'architecture/door_semi_open';
const QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_OPEN_ASSET_ID = 'architecture/door_open';
const QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_PLACEMENT_ID = 'club.skywalk_door_png';
const QORTAL_LAND_DEVELOPMENT_CLUB_BAR_ASSET_ID = 'furniture/bar_counter_long';
const QORTAL_LAND_DEVELOPMENT_CLUB_BAR_PLACEMENT_ID = 'club.bar_counter_long_wide_png';
const QORTAL_LAND_DEVELOPMENT_BACK_BAR_ASSET_ID = 'technology/back_bar_unit_long';
const QORTAL_LAND_DEVELOPMENT_BACK_BAR_PLACEMENT_ID = 'club.back_bar_unit_long_png';
const QORTAL_LAND_DEVELOPMENT_DJ_BOOTH_ASSET_ID = 'technology/dj_booth';
const QORTAL_LAND_DEVELOPMENT_DJ_BOOTH_PLACEMENT_ID = 'club.dj_booth_png';
const QORTAL_LAND_DEVELOPMENT_SOFA_MODERN_A_TEAL_ASSET_ID = 'furniture/sofa_modern_a_teal';
const QORTAL_LAND_DEVELOPMENT_SOFA_MODERN_A_PURPLE_ASSET_ID = 'furniture/sofa_modern_a_purple';
const QORTAL_LAND_DEVELOPMENT_TABLE_ROUND_LOW_ASSET_ID = 'furniture/table_round_low';
const QORTAL_LAND_DEVELOPMENT_BAR_STOOL_ROUND_ASSET_ID = 'furniture/bar_stool_round';
const QORTAL_LAND_DEVELOPMENT_SPEAKER_LEFT_ASSET_ID = 'technology/speaker_left';
const QORTAL_LAND_DEVELOPMENT_SPEAKER_RIGHT_ASSET_ID = 'technology/speaker_right';
const QORTAL_LAND_DEVELOPMENT_PLANTER_RECT_TROPICAL_ASSET_ID = 'decorations/planter_rect_tropical';
const QORTAL_LAND_DEVELOPMENT_PLANTER_TALL_TROPICAL_ASSET_ID = 'decorations/planter_tall_tropical';
const QORTAL_LAND_DEVELOPMENT_QORTAL_NEON_LIGHT_ASSET_ID = 'decorations/qortal_neon_light';
const QORTAL_LAND_DEVELOPMENT_DANCE_FLOOR_ASSET_ID = 'lighting/dance_floor';
const QORTAL_LAND_DEVELOPMENT_SOFA_MODERN_A_ASSET_IDS = [
  QORTAL_LAND_DEVELOPMENT_SOFA_MODERN_A_TEAL_ASSET_ID,
  QORTAL_LAND_DEVELOPMENT_SOFA_MODERN_A_PURPLE_ASSET_ID,
];
const QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_ASSET_IDS = [
  QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_CLOSED_ASSET_ID,
  QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_SEMI_OPEN_ASSET_ID,
  QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_OPEN_ASSET_ID,
];
const QORTAL_LAND_CLUB_SKYWALK_DOOR_PROXIMITY_RADIUS = 128;
const QORTAL_LAND_CLUB_SKYWALK_DOOR_SOURCE_WIDTH = 70;
const QORTAL_LAND_CLUB_SKYWALK_DOOR_SOURCE_HEIGHT = 365;
const QORTAL_LAND_CLUB_SKYWALK_DOOR_RETURN_OFFSET_X = 150;
const QORTAL_LAND_CLUB_SKYWALK_DOOR_RETURN_OFFSET_Y = -34;
const QORTAL_LAND_CLUB_SKYWALK_DOOR_OPEN_THRESHOLD = 0.78;
const QORTAL_LAND_CLUB_SKYWALK_DOOR_OPEN_SPEED = 0.0044;
const QORTAL_LAND_CLUB_SKYWALK_DOOR_CLOSE_SPEED = 0.0022;
const QORTAL_LAND_PLAYER_COLLISION_RADIUS_X = 18;
const QORTAL_LAND_PLAYER_COLLISION_RADIUS_Y = 10;
const QORTAL_LAND_DJ_PEDESTAL_MAX_ELEVATION = 52;

type QortalLandDevelopmentPngAsset = {
  id: string;
  path: string;
  url: string;
};

type QortalLandDevelopmentPngPropPlacement = {
  id: string;
  assetId: string;
  roomIds?: LandRoomId[];
  x: number;
  y: number;
  depth?: number;
  depthMode?: 'fixed' | 'y-sort';
  depthOffset?: number;
  originX?: number;
  originY?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  alpha?: number;
  flipX?: boolean;
  count?: number;
  spacing?: number;
  warp?: {
    tlX?: number;
    tlY?: number;
    trX?: number;
    trY?: number;
    brX?: number;
    brY?: number;
    blX?: number;
    blY?: number;
  };
  visible?: boolean;
  collision?: {
    shape: 'ellipse' | 'rect';
    offsetX?: number;
    offsetY?: number;
    width: number;
    height: number;
    paddingX?: number;
    paddingY?: number;
  };
  contactShadow?: {
    offsetX?: number;
    offsetY?: number;
    width: number;
    height: number;
    alpha?: number;
    color?: number;
    depth?: number;
    depthOffset?: number;
  };
};

type QortalLandDevelopmentLookSettings = {
  enabled: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
  shadow: number;
};

const QORTAL_LAND_DEVELOPMENT_LOOK_DEFAULTS: QortalLandDevelopmentLookSettings = {
  enabled: true,
  brightness: 1.1,
  contrast: 1.05,
  saturation: 1,
  shadow: 0.2,
};

const qortalLandDevelopmentPngModules = (import.meta as any).glob(
  '../../assets/qortalland/source/**/*.png',
  { eager: true, import: 'default' }
) as Record<string, string>;

const qortalLandDevelopmentPngAssets: QortalLandDevelopmentPngAsset[] = Object.entries(
  qortalLandDevelopmentPngModules
).map(([path, url]) => {
  const id = path
    .replace(/^.*\/qortalland\/source\//, '')
    .replace(/\.png$/i, '')
    .replace(/\\/g, '/');
  return { id, path, url };
});

const qortalLandDevelopmentPngAssetById = new Map(
  qortalLandDevelopmentPngAssets.map((asset) => [asset.id, asset])
);

const warnedMissingDevelopmentPngAssets = new Set<string>();

const qortalLandDevelopmentPngTextureKey = (assetId: string): string =>
  `${QORTAL_LAND_DEV_PNG_ASSET_KEY_PREFIX}:${assetId}`;

const clampQortalLandLookValue = (
  value: number,
  min: number,
  max: number,
  fallback: number
): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
};

const readQortalLandDevelopmentLookSettings = (): QortalLandDevelopmentLookSettings => {
  if (typeof window === 'undefined') return { ...QORTAL_LAND_DEVELOPMENT_LOOK_DEFAULTS };
  try {
    const raw = window.localStorage.getItem(QORTAL_LAND_DEV_LOOK_STORAGE_KEY);
    if (!raw) return { ...QORTAL_LAND_DEVELOPMENT_LOOK_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<QortalLandDevelopmentLookSettings>;
    return {
      enabled:
        typeof parsed.enabled === 'boolean'
          ? parsed.enabled
          : QORTAL_LAND_DEVELOPMENT_LOOK_DEFAULTS.enabled,
      brightness: clampQortalLandLookValue(
        Number(parsed.brightness),
        0.65,
        1.25,
        QORTAL_LAND_DEVELOPMENT_LOOK_DEFAULTS.brightness
      ),
      contrast: clampQortalLandLookValue(
        Number(parsed.contrast),
        0.75,
        1.55,
        QORTAL_LAND_DEVELOPMENT_LOOK_DEFAULTS.contrast
      ),
      saturation: clampQortalLandLookValue(
        Number(parsed.saturation),
        0.75,
        1.65,
        QORTAL_LAND_DEVELOPMENT_LOOK_DEFAULTS.saturation
      ),
      shadow: clampQortalLandLookValue(
        Number(parsed.shadow),
        0,
        0.5,
        QORTAL_LAND_DEVELOPMENT_LOOK_DEFAULTS.shadow
      ),
    };
  } catch {
    return { ...QORTAL_LAND_DEVELOPMENT_LOOK_DEFAULTS };
  }
};

const writeQortalLandDevelopmentLookSettings = (
  settings: QortalLandDevelopmentLookSettings
): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(QORTAL_LAND_DEV_LOOK_STORAGE_KEY, JSON.stringify(settings));
};

const qortalLandDevelopmentLookSignature = (
  settings: QortalLandDevelopmentLookSettings
): string =>
  [
    settings.enabled ? 'on' : 'off',
    settings.brightness.toFixed(3),
    settings.contrast.toFixed(3),
    settings.saturation.toFixed(3),
    settings.shadow.toFixed(3),
  ].join(':');

const readQortalLandDevelopmentPngPlacementOverride = (
  placementId: string
): Partial<QortalLandDevelopmentPngPropPlacement> => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(
      `${QORTAL_LAND_DEV_PNG_PLACEMENT_STORAGE_PREFIX}${placementId}`
    );
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const override: Partial<QortalLandDevelopmentPngPropPlacement> = {};
    for (const key of ['x', 'y', 'depth', 'depthOffset', 'originX', 'originY', 'scale', 'scaleX', 'scaleY', 'alpha', 'count', 'spacing'] as const) {
      const value = Number(parsed[key]);
      if (Number.isFinite(value)) {
        override[key] = value;
      }
    }
    if (typeof parsed.flipX === 'boolean') {
      override.flipX = parsed.flipX;
    }
    if (parsed.warp && typeof parsed.warp === 'object') {
      const warpSource = parsed.warp as Record<string, unknown>;
      const warp: NonNullable<QortalLandDevelopmentPngPropPlacement['warp']> = {};
      for (const key of ['tlX', 'tlY', 'trX', 'trY', 'brX', 'brY', 'blX', 'blY'] as const) {
        const value = Number(warpSource[key]);
        if (Number.isFinite(value)) {
          warp[key] = value;
        }
      }
      override.warp = warp;
    }
    return override;
  } catch {
    return {};
  }
};

const writeQortalLandDevelopmentPngPlacementOverride = (
  placementId: string,
  placement: Partial<QortalLandDevelopmentPngPropPlacement>
): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(
    `${QORTAL_LAND_DEV_PNG_PLACEMENT_STORAGE_PREFIX}${placementId}`,
    JSON.stringify(placement)
  );
};

const clearQortalLandDevelopmentPngPlacementOverride = (placementId: string): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(
    `${QORTAL_LAND_DEV_PNG_PLACEMENT_STORAGE_PREFIX}${placementId}`
  );
};

const notifyQortalLandDevelopmentAssetsChanged = (): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(QORTAL_LAND_DEV_ASSETS_CHANGED_EVENT));
};

const shouldShowQortalLandDevelopmentPngProps = (): boolean => {
  if (typeof window === 'undefined') return false;
  const queryMode = new URLSearchParams(window.location.search).get('qortallandAssets');
  if (queryMode === 'png' || queryMode === 'props' || queryMode === '1' || queryMode === 'true') {
    return true;
  }
  if (queryMode === 'procedural' || queryMode === '0' || queryMode === 'false') {
    return false;
  }
  return window.localStorage.getItem(QORTAL_LAND_DEV_PNG_PROPS_STORAGE_KEY) === '1';
};

const shouldShowQortalLandProceduralClubShell = (): boolean => {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(QORTAL_LAND_DEV_PROCEDURAL_CLUB_SHELL_STORAGE_KEY) !== '0';
};

const shouldShowQortalLandCollisionDebug = (): boolean => {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(QORTAL_LAND_DEV_COLLISION_DEBUG_STORAGE_KEY) === '1';
};

const shouldUseDevelopmentClubBarPng = (): boolean =>
  shouldShowQortalLandDevelopmentPngProps() &&
  qortalLandDevelopmentPngAssetById.has(QORTAL_LAND_DEVELOPMENT_CLUB_BAR_ASSET_ID);

const shouldUseDevelopmentClubSofasPng = (): boolean =>
  shouldShowQortalLandDevelopmentPngProps() &&
  QORTAL_LAND_DEVELOPMENT_SOFA_MODERN_A_ASSET_IDS.every((assetId) =>
    qortalLandDevelopmentPngAssetById.has(assetId)
  );

const QORTAL_LAND_DEVELOPMENT_CLUB_FLOOR_DEFAULT_PLACEMENT: QortalLandDevelopmentPngPropPlacement = {
  id: QORTAL_LAND_DEVELOPMENT_CLUB_FLOOR_PLACEMENT_ID,
  assetId: QORTAL_LAND_DEVELOPMENT_CLUB_FLOOR_ASSET_ID,
  roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
  x: 0,
  y: 0,
  depthMode: 'fixed',
  depth: -95,
  originX: 0,
  originY: 0,
  scale: 1,
};

const QORTAL_LAND_DEVELOPMENT_BACK_WALL_DEFAULT_PLACEMENT: QortalLandDevelopmentPngPropPlacement = {
  id: QORTAL_LAND_DEVELOPMENT_BACK_WALL_PLACEMENT_ID,
  assetId: QORTAL_LAND_DEVELOPMENT_BACK_WALL_ASSET_ID,
  roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
  x: 901,
  y: 314,
  depthMode: 'fixed',
  depth: -100,
  originX: 0.5,
  originY: 1,
  scale: 0.9,
};

const QORTAL_LAND_DEVELOPMENT_LEFT_WALL_DEFAULT_PLACEMENT: QortalLandDevelopmentPngPropPlacement = {
  id: QORTAL_LAND_DEVELOPMENT_LEFT_WALL_PLACEMENT_ID,
  assetId: QORTAL_LAND_DEVELOPMENT_LEFT_WALL_ASSET_ID,
  roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
  x: 188,
  y: 116,
  depthMode: 'fixed',
  depth: -98,
  originX: 0.464,
  originY: 0.105,
  scale: 1.09,
};

const QORTAL_LAND_DEVELOPMENT_RIGHT_WALL_DEFAULT_PLACEMENT: QortalLandDevelopmentPngPropPlacement = {
  id: QORTAL_LAND_DEVELOPMENT_RIGHT_WALL_PLACEMENT_ID,
  assetId: QORTAL_LAND_DEVELOPMENT_RIGHT_WALL_ASSET_ID,
  roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
  x: 1621,
  y: 39,
  depthMode: 'fixed',
  depth: -98,
  originX: 0.583,
  originY: -0.004,
  scale: 1.09,
};

const QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_DEFAULT_PLACEMENT: QortalLandDevelopmentPngPropPlacement = {
  id: QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_PLACEMENT_ID,
  assetId: QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_CLOSED_ASSET_ID,
  roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
  x: 1593,
  y: 362,
  depthMode: 'fixed',
  depth: -82,
  originX: 0.011,
  originY: 0.382,
  scale: 0.79,
  warp: {
    tlX: 11,
    tlY: 0,
    trX: 0,
    trY: 0,
    brX: 0,
    brY: 11,
    blX: 10,
    blY: 8,
  },
};

const QORTAL_LAND_DEVELOPMENT_CLUB_BAR_DEFAULT_PLACEMENT: QortalLandDevelopmentPngPropPlacement = {
  id: QORTAL_LAND_DEVELOPMENT_CLUB_BAR_PLACEMENT_ID,
  assetId: QORTAL_LAND_DEVELOPMENT_CLUB_BAR_ASSET_ID,
  roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
  x: 900,
  y: 400,
  depthMode: 'fixed',
  depth: 370,
  originX: 0.5,
  originY: 0.649,
  scaleX: 0.552,
  scaleY: 0.379,
  collision: {
    shape: 'rect',
    offsetY: -72,
    width: 1370,
    height: 165,
    paddingY: -7,
  },
};

const QORTAL_LAND_DEVELOPMENT_BACK_BAR_DEFAULT_PLACEMENT: QortalLandDevelopmentPngPropPlacement = {
  id: QORTAL_LAND_DEVELOPMENT_BACK_BAR_PLACEMENT_ID,
  assetId: QORTAL_LAND_DEVELOPMENT_BACK_BAR_ASSET_ID,
  roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
  x: 900,
  y: 202,
  depthMode: 'fixed',
  depth: 330,
  originX: 0.5,
  originY: 0.5,
  scale: 0.55,
};

const QORTAL_LAND_DEVELOPMENT_DJ_BOOTH_DEFAULT_PLACEMENT: QortalLandDevelopmentPngPropPlacement = {
  id: QORTAL_LAND_DEVELOPMENT_DJ_BOOTH_PLACEMENT_ID,
  assetId: QORTAL_LAND_DEVELOPMENT_DJ_BOOTH_ASSET_ID,
  roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
  x: 901,
  y: 277,
  depthMode: 'fixed',
  depth: 400,
  originX: 0.512,
  originY: 0.724,
  scale: 0.14,
  contactShadow: {
    offsetY: 11,
    width: 220,
    height: 14,
    alpha: 0.32,
    depth: 385,
  },
};

const QORTAL_LAND_DEVELOPMENT_SOFA_MODERN_A_DEFAULT_PLACEMENTS: QortalLandDevelopmentPngPropPlacement[] = [
  {
    id: 'club.sofa_modern_a_teal_png',
    assetId: QORTAL_LAND_DEVELOPMENT_SOFA_MODERN_A_TEAL_ASSET_ID,
    roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
    x: 1340,
    y: 542,
    depth: 480,
    depthMode: 'y-sort',
    depthOffset: 20,
    originX: 0.5,
    originY: 0.9,
    scale: 0.19,
    alpha: 1,
    contactShadow: {
      offsetY: 6,
      width: 230,
      height: 28,
      alpha: 0.24,
    },
    collision: {
      shape: 'ellipse',
      offsetY: -10,
      width: 900,
      height: 170,
    },
  },
  {
    id: 'club.sofa_modern_a_purple_png',
    assetId: QORTAL_LAND_DEVELOPMENT_SOFA_MODERN_A_PURPLE_ASSET_ID,
    roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
    x: 405,
    y: 542,
    depth: 665,
    depthMode: 'y-sort',
    depthOffset: 20,
    originX: 0.5,
    originY: 0.9,
    scale: 0.21,
    alpha: 1,
    contactShadow: {
      offsetY: 6,
      width: 250,
      height: 30,
      alpha: 0.24,
    },
    collision: {
      shape: 'ellipse',
      offsetY: -10,
      width: 900,
      height: 170,
    },
  },
];

const QORTAL_LAND_DEVELOPMENT_TABLE_DEFAULT_PLACEMENTS: QortalLandDevelopmentPngPropPlacement[] = [
  {
    id: 'club.table_round_low_left_png',
    assetId: QORTAL_LAND_DEVELOPMENT_TABLE_ROUND_LOW_ASSET_ID,
    roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
    x: 403,
    y: 581,
    depth: 685,
    depthMode: 'y-sort',
    depthOffset: 20,
    originX: 0.5,
    originY: 0.88,
    scale: 0.14,
    alpha: 1,
    contactShadow: {
      offsetY: 4,
      width: 136,
      height: 24,
      alpha: 0.2,
    },
    collision: {
      shape: 'ellipse',
      offsetY: -6,
      width: 760,
      height: 300,
    },
  },
  {
    id: 'club.table_round_low_right_png',
    assetId: QORTAL_LAND_DEVELOPMENT_TABLE_ROUND_LOW_ASSET_ID,
    roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
    x: 1336,
    y: 581,
    depthMode: 'y-sort',
    depthOffset: 20,
    originX: 0.5,
    originY: 0.88,
    scale: 0.14,
    alpha: 1,
    contactShadow: {
      offsetY: 4,
      width: 136,
      height: 24,
      alpha: 0.2,
    },
    collision: {
      shape: 'ellipse',
      offsetY: -6,
      width: 760,
      height: 300,
    },
  },
];

const QORTAL_LAND_DEVELOPMENT_BAR_STOOL_GROUP_DEFAULT_PLACEMENT: QortalLandDevelopmentPngPropPlacement = {
  id: 'club.bar_stool_round_group_png',
  assetId: QORTAL_LAND_DEVELOPMENT_BAR_STOOL_ROUND_ASSET_ID,
  roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
  x: 900,
  y: 402,
  depthMode: 'y-sort',
  depthOffset: 20,
  originX: 0.5,
  originY: 0.863,
  scale: 0.14,
  alpha: 1,
  count: 5,
  spacing: 118,
  contactShadow: {
    offsetY: 4,
    width: 52,
    height: 14,
    alpha: 0.18,
  },
  collision: {
    shape: 'ellipse',
    offsetY: 10,
    width: 190,
    height: 180,
    paddingX: -7,
    paddingY: -4,
  },
};

const QORTAL_LAND_DEVELOPMENT_SPEAKER_DEFAULT_PLACEMENTS: QortalLandDevelopmentPngPropPlacement[] = [
  {
    id: 'club.speaker_left_png',
    assetId: QORTAL_LAND_DEVELOPMENT_SPEAKER_LEFT_ASSET_ID,
    roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
    x: 215,
    y: 636,
    depthMode: 'y-sort',
    depthOffset: 20,
    originX: 0.5,
    originY: 0.976,
    scale: 0.66,
    alpha: 1,
    contactShadow: {
      offsetY: 5,
      width: 74,
      height: 18,
      alpha: 0.22,
    },
    collision: {
      shape: 'ellipse',
      offsetY: -36,
      width: 84,
      height: 92,
    },
  },
  {
    id: 'club.speaker_right_png',
    assetId: QORTAL_LAND_DEVELOPMENT_SPEAKER_RIGHT_ASSET_ID,
    roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
    x: 1590,
    y: 636,
    depthMode: 'y-sort',
    depthOffset: 20,
    originX: 0.5,
    originY: 0.954,
    scale: 0.66,
    alpha: 1,
    contactShadow: {
      offsetY: 5,
      width: 74,
      height: 18,
      alpha: 0.22,
    },
    collision: {
      shape: 'ellipse',
      offsetY: -36,
      width: 84,
      height: 92,
    },
  },
];

const QORTAL_LAND_DEVELOPMENT_DECORATION_DEFAULT_PLACEMENTS: QortalLandDevelopmentPngPropPlacement[] = [
  {
    id: 'club.planter_rect_tropical_png',
    assetId: QORTAL_LAND_DEVELOPMENT_PLANTER_RECT_TROPICAL_ASSET_ID,
    roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
    x: 1407,
    y: 335,
    depthMode: 'y-sort',
    depthOffset: 20,
    originX: 0.553,
    originY: 0.847,
    scale: 0.18,
    alpha: 1,
    contactShadow: {
      offsetY: 5,
      width: 180,
      height: 24,
      alpha: 0.22,
    },
    collision: {
      shape: 'ellipse',
      offsetY: 18,
      width: 760,
      height: 190,
    },
  },
  {
    id: 'club.planter_tall_tropical_png',
    assetId: QORTAL_LAND_DEVELOPMENT_PLANTER_TALL_TROPICAL_ASSET_ID,
    roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
    x: 409,
    y: 320,
    depthMode: 'y-sort',
    depthOffset: 20,
    originX: 0.5,
    originY: 0.915,
    scale: 0.16,
    alpha: 1,
    contactShadow: {
      offsetY: 5,
      width: 92,
      height: 22,
      alpha: 0.22,
    },
    collision: {
      shape: 'ellipse',
      offsetY: 12,
      width: 430,
      height: 230,
    },
  },
  {
    id: 'club.qortal_neon_light_png',
    assetId: QORTAL_LAND_DEVELOPMENT_QORTAL_NEON_LIGHT_ASSET_ID,
    roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
    x: 1569,
    y: 242,
    depthMode: 'fixed',
    depth: 335,
    originX: 0.581,
    originY: 0.472,
    scale: 0.2,
    alpha: 1,
    warp: {
      tlX: 250,
      tlY: 0,
      trX: -50,
      trY: 0,
      brX: 0,
      brY: 500,
      blX: 220,
      blY: 0,
    },
  },
];

const QORTAL_LAND_DEVELOPMENT_DANCE_FLOOR_DEFAULT_PLACEMENT: QortalLandDevelopmentPngPropPlacement = {
  id: 'club.dance_floor_png',
  assetId: QORTAL_LAND_DEVELOPMENT_DANCE_FLOOR_ASSET_ID,
  roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
  x: 900,
  y: 537,
  depthMode: 'fixed',
  depth: -86,
  originX: 0.5,
  originY: 0.5,
  scale: 0.72,
  alpha: 1,
};

const getQortalLandDevelopmentClubBarPlacement = (): QortalLandDevelopmentPngPropPlacement => ({
  ...QORTAL_LAND_DEVELOPMENT_CLUB_BAR_DEFAULT_PLACEMENT,
  ...readQortalLandDevelopmentPngPlacementOverride(QORTAL_LAND_DEVELOPMENT_CLUB_BAR_PLACEMENT_ID),
});

const getQortalLandDevelopmentBackBarPlacement = (): QortalLandDevelopmentPngPropPlacement => ({
  ...QORTAL_LAND_DEVELOPMENT_BACK_BAR_DEFAULT_PLACEMENT,
  ...readQortalLandDevelopmentPngPlacementOverride(
    QORTAL_LAND_DEVELOPMENT_BACK_BAR_PLACEMENT_ID
  ),
});

const getQortalLandDevelopmentDjBoothPlacement = (): QortalLandDevelopmentPngPropPlacement => ({
  ...QORTAL_LAND_DEVELOPMENT_DJ_BOOTH_DEFAULT_PLACEMENT,
  ...readQortalLandDevelopmentPngPlacementOverride(
    QORTAL_LAND_DEVELOPMENT_DJ_BOOTH_PLACEMENT_ID
  ),
});

const getQortalLandDevelopmentClubDoorPlacement = (): QortalLandDevelopmentPngPropPlacement => ({
  ...QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_DEFAULT_PLACEMENT,
  ...readQortalLandDevelopmentPngPlacementOverride(
    QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_PLACEMENT_ID
  ),
});

const QORTAL_LAND_EDITABLE_DEVELOPMENT_PLACEMENTS = [
  {
    label: 'Club Floor',
    sourceLabel: 'source/architecture/club_floor.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_CLUB_FLOOR_DEFAULT_PLACEMENT,
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Main Back Wall',
    sourceLabel: 'source/architecture/back_wall_main.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_BACK_WALL_DEFAULT_PLACEMENT,
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Left Wall',
    sourceLabel: 'source/architecture/club_wall_left.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_LEFT_WALL_DEFAULT_PLACEMENT,
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Right Wall',
    sourceLabel: 'source/architecture/club_wall_right.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_RIGHT_WALL_DEFAULT_PLACEMENT,
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Club Door',
    sourceLabel: 'source/architecture/door_closed.png + door_semi_open.png + door_open.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_DEFAULT_PLACEMENT,
    allowSeparateScale: false,
    allowWarp: true,
    allowGroupControls: false,
  },
  {
    label: 'Club Bar',
    sourceLabel: 'source/furniture/bar_counter_long.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_CLUB_BAR_DEFAULT_PLACEMENT,
    allowSeparateScale: true,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Back Bar Unit',
    sourceLabel: 'source/technology/back_bar_unit_long.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_BACK_BAR_DEFAULT_PLACEMENT,
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'DJ Booth',
    sourceLabel: 'source/technology/dj_booth.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_DJ_BOOTH_DEFAULT_PLACEMENT,
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Dance Floor',
    sourceLabel: 'source/lighting/dance_floor.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_DANCE_FLOOR_DEFAULT_PLACEMENT,
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Sofa Teal',
    sourceLabel: 'source/furniture/sofa_modern_a_teal.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_SOFA_MODERN_A_DEFAULT_PLACEMENTS[0],
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Sofa Purple',
    sourceLabel: 'source/furniture/sofa_modern_a_purple.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_SOFA_MODERN_A_DEFAULT_PLACEMENTS[1],
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Small Table Left',
    sourceLabel: 'source/furniture/table_round_low.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_TABLE_DEFAULT_PLACEMENTS[0],
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Small Table Right',
    sourceLabel: 'source/furniture/table_round_low.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_TABLE_DEFAULT_PLACEMENTS[1],
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Bar Stools',
    sourceLabel: 'source/furniture/bar_stool_round.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_BAR_STOOL_GROUP_DEFAULT_PLACEMENT,
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: true,
  },
  {
    label: 'Speaker Left',
    sourceLabel: 'source/technology/speaker_left.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_SPEAKER_DEFAULT_PLACEMENTS[0],
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Speaker Right',
    sourceLabel: 'source/technology/speaker_right.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_SPEAKER_DEFAULT_PLACEMENTS[1],
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Planter Wide',
    sourceLabel: 'source/decorations/planter_rect_tropical.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_DECORATION_DEFAULT_PLACEMENTS[0],
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Planter Tall',
    sourceLabel: 'source/decorations/planter_tall_tropical.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_DECORATION_DEFAULT_PLACEMENTS[1],
    allowSeparateScale: false,
    allowWarp: false,
    allowGroupControls: false,
  },
  {
    label: 'Qortal Neon Light',
    sourceLabel: 'source/decorations/qortal_neon_light.png',
    defaultPlacement: QORTAL_LAND_DEVELOPMENT_DECORATION_DEFAULT_PLACEMENTS[2],
    allowSeparateScale: false,
    allowWarp: true,
    allowGroupControls: false,
  },
] as const;

type QortalLandEditableDevelopmentPlacement =
  (typeof QORTAL_LAND_EDITABLE_DEVELOPMENT_PLACEMENTS)[number];

const getQortalLandEditableDevelopmentPlacement = (
  placementId: string
): QortalLandEditableDevelopmentPlacement =>
  QORTAL_LAND_EDITABLE_DEVELOPMENT_PLACEMENTS.find(
    (placement) => placement.defaultPlacement.id === placementId
  ) ?? QORTAL_LAND_EDITABLE_DEVELOPMENT_PLACEMENTS[0];

const getQortalLandDevelopmentPlacement = (
  defaultPlacement: QortalLandDevelopmentPngPropPlacement
): QortalLandDevelopmentPngPropPlacement => ({
  ...defaultPlacement,
  ...readQortalLandDevelopmentPngPlacementOverride(defaultPlacement.id),
});

const shouldSkipQortalLandDevelopmentLook = (
  placement: QortalLandDevelopmentPngPropPlacement
): boolean =>
  placement.assetId === QORTAL_LAND_DEVELOPMENT_BACK_BAR_ASSET_ID ||
  placement.assetId === QORTAL_LAND_DEVELOPMENT_SPEAKER_LEFT_ASSET_ID ||
  placement.assetId === QORTAL_LAND_DEVELOPMENT_SPEAKER_RIGHT_ASSET_ID;

const qortalLandPlacementScaleForAxis = (
  placement: QortalLandDevelopmentPngPropPlacement,
  axis: 'x' | 'y'
): number => {
  const value = axis === 'x'
    ? placement.scaleX ?? placement.scale ?? 1
    : placement.scaleY ?? placement.scale ?? 1;
  return Number.isFinite(value) ? value : 1;
};

const qortalLandClubSkywalkDoorHotspot = (
  placement = getQortalLandDevelopmentClubDoorPlacement()
): {
  x: number;
  y: number;
  proximityRadius: number;
  passMinX: number;
  passMaxX: number;
  passMinY: number;
  passMaxY: number;
  returnX: number;
  returnY: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
} => {
  const scaleX = qortalLandPlacementScaleForAxis(placement, 'x');
  const scaleY = qortalLandPlacementScaleForAxis(placement, 'y');
  const originX = placement.originX ?? 0.5;
  const originY = placement.originY ?? 0.5;
  const left = placement.x - originX * QORTAL_LAND_CLUB_SKYWALK_DOOR_SOURCE_WIDTH * scaleX;
  const right = placement.x + (1 - originX) * QORTAL_LAND_CLUB_SKYWALK_DOOR_SOURCE_WIDTH * scaleX;
  const top = placement.y - originY * QORTAL_LAND_CLUB_SKYWALK_DOOR_SOURCE_HEIGHT * scaleY;
  const bottom = placement.y + (1 - originY) * QORTAL_LAND_CLUB_SKYWALK_DOOR_SOURCE_HEIGHT * scaleY;
  const walkY = top + (bottom - top) * 0.78;
  const approach = clampLandPosition(
    QORTAL_LAND_DEFAULT_ROOM_ID,
    right - 68,
    walkY
  );
  const returnTarget = clampLandPosition(
    QORTAL_LAND_DEFAULT_ROOM_ID,
    right - QORTAL_LAND_CLUB_SKYWALK_DOOR_RETURN_OFFSET_X,
    walkY + QORTAL_LAND_CLUB_SKYWALK_DOOR_RETURN_OFFSET_Y
  );
  return {
    x: approach.x,
    y: approach.y,
    proximityRadius: QORTAL_LAND_CLUB_SKYWALK_DOOR_PROXIMITY_RADIUS,
    passMinX: right - 20,
    passMaxX: right + 18,
    passMinY: top + 90 * Math.abs(scaleY),
    passMaxY: bottom + 24 * Math.abs(scaleY),
    returnX: returnTarget.x,
    returnY: returnTarget.y,
    left,
    right,
    top,
    bottom,
  };
};

const QORTAL_LAND_DEVELOPMENT_PNG_PROP_PLACEMENTS: QortalLandDevelopmentPngPropPlacement[] = [
  QORTAL_LAND_DEVELOPMENT_CLUB_BAR_DEFAULT_PLACEMENT,
  QORTAL_LAND_DEVELOPMENT_BACK_BAR_DEFAULT_PLACEMENT,
  QORTAL_LAND_DEVELOPMENT_DJ_BOOTH_DEFAULT_PLACEMENT,
  ...QORTAL_LAND_DEVELOPMENT_SOFA_MODERN_A_DEFAULT_PLACEMENTS,
  ...QORTAL_LAND_DEVELOPMENT_TABLE_DEFAULT_PLACEMENTS,
  QORTAL_LAND_DEVELOPMENT_BAR_STOOL_GROUP_DEFAULT_PLACEMENT,
  ...QORTAL_LAND_DEVELOPMENT_SPEAKER_DEFAULT_PLACEMENTS,
  ...QORTAL_LAND_DEVELOPMENT_DECORATION_DEFAULT_PLACEMENTS,
  QORTAL_LAND_DEVELOPMENT_DANCE_FLOOR_DEFAULT_PLACEMENT,
  // Add transparent PNGs under src/assets/qortalland/source/** and place them here.
  // Example:
  // {
  //   id: 'club.dj_booth_png',
  //   assetId: 'technology/dj_booth_neon',
  //   roomIds: [QORTAL_LAND_DEFAULT_ROOM_ID],
  //   x: 900,
  //   y: 374,
  //   depthMode: 'fixed',
  //   depth: 370,
  //   originX: 0.5,
  //   originY: 1,
  //   scale: 1,
  // },
];

type ReticulumChatEventForLand = {
  eventId?: unknown;
  groupId?: unknown;
  channelId?: unknown;
  authorAddress?: unknown;
  authorPublicKey?: unknown;
  authorSeq?: unknown;
  timestamp?: unknown;
  eventType?: unknown;
  encryptedPayload?: unknown;
  payloadHash?: unknown;
  mentionAddressHashes?: unknown;
  signature?: unknown;
};

const createSessionId = (): string => {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID().replace(/-/g, '').slice(0, 24);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`.slice(0, 24);
};

const createLandChatMessageId = (): string => {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
};

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || target.isContentEditable;
};

const addressHue = (address: string): number => {
  let hash = 0;
  for (let index = 0; index < address.length; index += 1) {
    hash = (hash * 31 + address.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
};

const shortAddress = (address: string): string => {
  const trimmed = address.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
};

const displayNameForAddress = (
  address: string,
  primaryNameCache: Map<string, string>
): string => {
  const primaryName = primaryNameCache.get(address)?.trim();
  return primaryName || shortAddress(address);
};

const clampNumber = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const finiteNumber = (value: unknown): number | null => {
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
};

const estimateRemoteInterpolationMs = (distance: number, stateGapMs: number): number => {
  const distanceWindow = distance * 3.2;
  const gapWindow = stateGapMs > LAND_SEND_INTERVAL_MS * 2 ? stateGapMs * 0.42 : 0;
  return clampNumber(
    Math.max(LAND_REMOTE_MIN_INTERPOLATION_MS, distanceWindow, gapWindow),
    LAND_REMOTE_MIN_INTERPOLATION_MS,
    LAND_REMOTE_MAX_INTERPOLATION_MS
  );
};

const clampRemoteVelocity = (velocity: number): number => {
  return clampNumber(velocity, -LAND_REMOTE_MAX_VELOCITY_PX_PER_MS, LAND_REMOTE_MAX_VELOCITY_PX_PER_MS);
};

const normalizeLandRoomId = (value: unknown): LandRoomId => {
  return value === QORTAL_LAND_SKYWALK_ROOM_ID ||
    value === QORTAL_LAND_MALL_ROOM_ID ||
    value === QORTAL_LAND_PARK_ROOM_ID
    ? value
    : QORTAL_LAND_DEFAULT_ROOM_ID;
};

const initialPositionForAddress = (address: string): { roomId: LandRoomId; x: number; y: number } => {
  const hue = addressHue(address);
  return {
    roomId: QORTAL_LAND_DEFAULT_ROOM_ID,
    x: 430 + (hue % 8) * 110,
    y: 490 + (hue % 4) * 28,
  };
};

const roomLayoutForRoom = (roomId: LandRoomId): QortalLandRoomLayout =>
  QORTAL_LAND_ROOM_LAYOUTS[roomId] ?? QORTAL_LAND_ROOM_LAYOUTS[QORTAL_LAND_DEFAULT_ROOM_ID];

const roomSizeForRoom = (roomId: LandRoomId): { width: number; height: number } => {
  const layout = roomLayoutForRoom(roomId);
  return { width: layout.width, height: layout.height };
};

const roomFloorRange = (roomId: LandRoomId): { top: number; bottom: number } => {
  const floor = roomLayoutForRoom(roomId).floor;
  return { top: floor.topY, bottom: floor.bottomY };
};

const floorBoundsForRoomY = (roomId: LandRoomId, y: number): { minX: number; maxX: number } => {
  const floor = roomLayoutForRoom(roomId).floor;
  const ratio = Math.max(0, Math.min(1, (y - floor.topY) / (floor.bottomY - floor.topY)));
  return {
    minX: floor.back.minX + (floor.front.minX - floor.back.minX) * ratio,
    maxX: floor.back.maxX + (floor.front.maxX - floor.back.maxX) * ratio,
  };
};

const floorBoundsForY = (y: number): { minX: number; maxX: number } => {
  return floorBoundsForRoomY(QORTAL_LAND_DEFAULT_ROOM_ID, y);
};

const floorScaleForRoomY = (roomId: LandRoomId, y: number): number => {
  const range = roomFloorRange(roomId);
  const ratio = Math.max(0, Math.min(1, (y - range.top) / (range.bottom - range.top)));
  return 0.78 + ratio * 0.36;
};

const characterScaleForRoomY = (roomId: LandRoomId, y: number): number => {
  return floorScaleForRoomY(roomId, y) * LAND_CHARACTER_RENDER_SCALE;
};

const avatarScaleXForDirection = (direction: string, scale: number): number => {
  return direction === 'l' ? -scale : scale;
};

const avatarAnimationKeyForDirection = (direction: string, moving: boolean): string => {
  if (direction === 'u') {
    return moving ? LAND_CHARACTER_WALK_UP_ANIM_KEY : LAND_CHARACTER_IDLE_UP_ANIM_KEY;
  }
  if (direction === 'd') {
    return moving ? LAND_CHARACTER_WALK_DOWN_ANIM_KEY : LAND_CHARACTER_IDLE_DOWN_ANIM_KEY;
  }
  return moving ? LAND_CHARACTER_WALK_SIDE_ANIM_KEY : LAND_CHARACTER_IDLE_SIDE_ANIM_KEY;
};

const clampLandPosition = (
  roomId: LandRoomId,
  x: number,
  y: number
): { x: number; y: number } => {
  const range = roomFloorRange(roomId);
  const nextY = Math.max(range.top + 24, Math.min(range.bottom - 28, y));
  const bounds = floorBoundsForRoomY(roomId, nextY);
  return {
    x: Math.max(bounds.minX + 35, Math.min(bounds.maxX - 35, x)),
    y: nextY,
  };
};

type QortalLandCollisionFootprint = {
  shape: 'ellipse' | 'rect';
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  paddingX: number;
  paddingY: number;
};

const qortalLandCollisionFootprintsForRoom = (
  roomId: LandRoomId
): QortalLandCollisionFootprint[] => {
  if (!shouldShowQortalLandDevelopmentPngProps()) return [];
  const footprints: QortalLandCollisionFootprint[] = [];
  for (const basePlacement of QORTAL_LAND_DEVELOPMENT_PNG_PROP_PLACEMENTS) {
    if (!basePlacement.collision) continue;
    const placement = {
      ...basePlacement,
      ...readQortalLandDevelopmentPngPlacementOverride(basePlacement.id),
    };
    if (placement.visible === false) continue;
    if (placement.roomIds && !placement.roomIds.includes(roomId)) continue;
    if (!placement.collision) continue;

    const scaleX = qortalLandPlacementScaleForAxis(placement, 'x');
    const scaleY = qortalLandPlacementScaleForAxis(placement, 'y');
    const instanceCount = Math.max(1, Math.min(12, Math.round(placement.count ?? 1)));
    const spacing = placement.spacing ?? 0;
    const startOffsetX = -((instanceCount - 1) * spacing) / 2;
    const offsetX = (placement.collision.offsetX ?? 0) * (placement.flipX ? -scaleX : scaleX);
    const offsetY = (placement.collision.offsetY ?? 0) * scaleY;
    const radiusX = Math.max(2, Math.abs(placement.collision.width * scaleX) / 2);
    const radiusY = Math.max(2, Math.abs(placement.collision.height * scaleY) / 2);
    const paddingX = placement.collision.paddingX ?? 0;
    const paddingY = placement.collision.paddingY ?? 0;

    for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
      footprints.push({
        shape: placement.collision.shape,
        x: placement.x + startOffsetX + instanceIndex * spacing + offsetX,
        y: placement.y + offsetY,
        radiusX,
        radiusY,
        paddingX,
        paddingY,
      });
    }
  }
  return footprints;
};

const qortalLandExpandedCollisionRadii = (
  footprint: QortalLandCollisionFootprint
): { x: number; y: number } => ({
  x: Math.max(2, footprint.radiusX + QORTAL_LAND_PLAYER_COLLISION_RADIUS_X + footprint.paddingX),
  y: Math.max(2, footprint.radiusY + QORTAL_LAND_PLAYER_COLLISION_RADIUS_Y + footprint.paddingY),
});

const qortalLandSmoothStep = (value: number): number => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

const qortalLandTrapezoidFactor = (
  value: number,
  zeroStart: number,
  fullStart: number,
  fullEnd: number,
  zeroEnd: number
): number => {
  if (value <= zeroStart || value >= zeroEnd) return 0;
  if (value >= fullStart && value <= fullEnd) return 1;
  if (value < fullStart) {
    return qortalLandSmoothStep((value - zeroStart) / (fullStart - zeroStart));
  }
  return qortalLandSmoothStep((zeroEnd - value) / (zeroEnd - fullEnd));
};

const qortalLandDjPedestalElevationForPosition = (
  roomId: LandRoomId,
  x: number,
  y: number
): number => {
  if (roomId !== QORTAL_LAND_DEFAULT_ROOM_ID) return 0;
  const xFactor = qortalLandTrapezoidFactor(x, 690, 790, 1010, 1110);
  const yFactor = qortalLandTrapezoidFactor(y, 302, 326, 365, 425);
  return QORTAL_LAND_DJ_PEDESTAL_MAX_ELEVATION * Math.min(xFactor, yFactor);
};

const qortalLandAvatarRenderY = (roomId: LandRoomId, x: number, y: number): number =>
  y - qortalLandDjPedestalElevationForPosition(roomId, x, y);

const isQortalLandCollisionBlocked = (
  footprint: QortalLandCollisionFootprint,
  x: number,
  y: number
): boolean => {
  const expanded = qortalLandExpandedCollisionRadii(footprint);
  const dx = x - footprint.x;
  const dy = y - footprint.y;
  if (footprint.shape === 'rect') {
    return Math.abs(dx) <= expanded.x && Math.abs(dy) <= expanded.y;
  }
  const normalizedX = dx / expanded.x;
  const normalizedY = dy / expanded.y;
  return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
};

const isQortalLandPositionBlockedByProps = (
  roomId: LandRoomId,
  x: number,
  y: number
): boolean =>
  qortalLandCollisionFootprintsForRoom(roomId).some((footprint) =>
    isQortalLandCollisionBlocked(footprint, x, y)
  );

const resolveQortalLandPropCollisions = (
  roomId: LandRoomId,
  previousX: number,
  previousY: number,
  nextX: number,
  nextY: number
): { x: number; y: number } => {
  if (roomId !== QORTAL_LAND_DEFAULT_ROOM_ID) return { x: nextX, y: nextY };
  const footprints = qortalLandCollisionFootprintsForRoom(roomId);
  if (!footprints.length) return { x: nextX, y: nextY };

  let x = nextX;
  let y = nextY;
  for (let pass = 0; pass < 4; pass += 1) {
    let moved = false;
    for (const footprint of footprints) {
      if (!isQortalLandCollisionBlocked(footprint, x, y)) continue;
      const expanded = qortalLandExpandedCollisionRadii(footprint);
      const dx = x - footprint.x;
      const dy = y - footprint.y;
      if (footprint.shape === 'rect') {
        const overlapX = expanded.x - Math.abs(dx);
        const overlapY = expanded.y - Math.abs(dy);
        if (overlapX < overlapY) {
          const fallback = previousX === footprint.x ? 1 : Math.sign(previousX - footprint.x);
          x += (Math.sign(dx) || fallback || 1) * (overlapX + 0.5);
        } else {
          const fallback = previousY === footprint.y ? 1 : Math.sign(previousY - footprint.y);
          y += (Math.sign(dy) || fallback || 1) * (overlapY + 0.5);
        }
      } else {
        const normalizedX = dx / expanded.x;
        const normalizedY = dy / expanded.y;
        const distance = Math.hypot(normalizedX, normalizedY);
        const fallbackX = previousX - footprint.x;
        const fallbackY = previousY - footprint.y;
        const fallbackDistance = Math.hypot(fallbackX / expanded.x, fallbackY / expanded.y);
        const pushX = distance > 0.0001
          ? normalizedX / distance
          : fallbackDistance > 0.0001
            ? (fallbackX / expanded.x) / fallbackDistance
            : 0;
        const pushY = distance > 0.0001
          ? normalizedY / distance
          : fallbackDistance > 0.0001
            ? (fallbackY / expanded.y) / fallbackDistance
            : 1;
        x = footprint.x + pushX * (expanded.x + 0.5);
        y = footprint.y + pushY * (expanded.y + 0.5);
      }
      ({ x, y } = clampLandPosition(roomId, x, y));
      moved = true;
    }
    if (!moved) return { x, y };
  }

  const xOnly = clampLandPosition(roomId, nextX, previousY);
  if (!isQortalLandPositionBlockedByProps(roomId, xOnly.x, xOnly.y)) return xOnly;
  const yOnly = clampLandPosition(roomId, previousX, nextY);
  if (!isQortalLandPositionBlockedByProps(roomId, yOnly.x, yOnly.y)) return yOnly;
  return clampLandPosition(roomId, previousX, previousY);
};

const isNearClubDjBooth = (roomId: LandRoomId, x: number, y: number): boolean => {
  if (roomId !== QORTAL_LAND_DEFAULT_ROOM_ID) return false;
  if (qortalLandDjPedestalElevationForPosition(roomId, x, y) < 12) return false;
  const hotspot = roomLayoutForRoom(QORTAL_LAND_DEFAULT_ROOM_ID).interactions?.djBooth;
  if (!hotspot) return false;
  const weightedX = (x - hotspot.x) * hotspot.weightedXScale;
  const weightedY = y - hotspot.y;
  return Math.hypot(weightedX, weightedY) <= hotspot.radius;
};

export function QortalLand({ groupId, groupName, myAddress }: QortalLandProps) {
  const theme = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<import('phaser').Game | null>(null);
  const movementKeysRef = useRef<Set<string>>(new Set());
  const remotePlayersRef = useRef<Map<string, LandPlayerState>>(new Map());
  const landChatBubblesRef = useRef<Map<string, LandChatBubble>>(new Map());
  const primaryNameCacheRef = useRef<Map<string, string>>(new Map());
  const pendingPrimaryNameLookupsRef = useRef<Set<string>>(new Set());
  const primaryNameLookupTimerRef = useRef<number | null>(null);
  const currentRoomRef = useRef<LandRoomId>(QORTAL_LAND_DEFAULT_ROOM_ID);
  const localStateRef = useRef<LocalLandState>({
    ...initialPositionForAddress(myAddress || ''),
    direction: 'r',
    movement: 'idle',
  });
  const lastSentRef = useRef<LocalLandState & { sentAt: number }>({
    ...localStateRef.current,
    sentAt: 0,
  });
  const sequenceRef = useRef(0);
  const landChatSequenceRef = useRef(0);
  const chatAuthorSeqRef = useRef(0);
  const [reticulumReady, setReticulumReady] = useState<boolean | null>(null);
  const [chatText, setChatText] = useState('');
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [chatError, setChatError] = useState('');
  const [isAssetDevPanelOpen, setIsAssetDevPanelOpen] = useState(false);
  const [devPngPropsEnabled, setDevPngPropsEnabled] = useState(() =>
    shouldShowQortalLandDevelopmentPngProps()
  );
  const [devClubBarPlacement, setDevClubBarPlacement] = useState(() =>
    getQortalLandDevelopmentClubBarPlacement()
  );
  const [devBackBarPlacement, setDevBackBarPlacement] = useState(() =>
    getQortalLandDevelopmentBackBarPlacement()
  );
  const [devDjBoothPlacement, setDevDjBoothPlacement] = useState(() =>
    getQortalLandDevelopmentDjBoothPlacement()
  );
  const [selectedDevPlacementId, setSelectedDevPlacementId] = useState(
    QORTAL_LAND_DEVELOPMENT_BACK_WALL_PLACEMENT_ID
  );
  const [selectedDevPlacement, setSelectedDevPlacement] = useState(() =>
    getQortalLandDevelopmentPlacement(
      getQortalLandEditableDevelopmentPlacement(
        QORTAL_LAND_DEVELOPMENT_BACK_WALL_PLACEMENT_ID
      ).defaultPlacement
    )
  );
  const [proceduralClubShellEnabled, setProceduralClubShellEnabled] = useState(() =>
    shouldShowQortalLandProceduralClubShell()
  );
  const [collisionDebugEnabled, setCollisionDebugEnabled] = useState(() =>
    shouldShowQortalLandCollisionDebug()
  );
  const [developmentLookSettings, setDevelopmentLookSettings] = useState(() =>
    readQortalLandDevelopmentLookSettings()
  );
  const sessionId = useMemo(() => createSessionId(), []);

  const setDevelopmentPngPropsEnabled = useCallback((enabled: boolean) => {
    if (enabled) {
      window.localStorage.setItem(QORTAL_LAND_DEV_PNG_PROPS_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(QORTAL_LAND_DEV_PNG_PROPS_STORAGE_KEY);
    }
    setDevPngPropsEnabled(enabled);
    notifyQortalLandDevelopmentAssetsChanged();
  }, []);

  const selectedDevPlacementMeta = getQortalLandEditableDevelopmentPlacement(selectedDevPlacementId);

  const selectDevelopmentPlacement = useCallback((placementId: string) => {
    const meta = getQortalLandEditableDevelopmentPlacement(placementId);
    setSelectedDevPlacementId(meta.defaultPlacement.id);
    setSelectedDevPlacement(getQortalLandDevelopmentPlacement(meta.defaultPlacement));
  }, []);

  const writeSelectedDevelopmentPlacement = useCallback(
    (placement: QortalLandDevelopmentPngPropPlacement) => {
      writeQortalLandDevelopmentPngPlacementOverride(placement.id, {
        x: placement.x,
        y: placement.y,
        depth: placement.depth,
        originX: placement.originX,
        originY: placement.originY,
        scale: placement.scale,
        scaleX: placement.scaleX,
        scaleY: placement.scaleY,
        alpha: placement.alpha,
        count: placement.count,
        spacing: placement.spacing,
        warp: placement.warp,
      });
      notifyQortalLandDevelopmentAssetsChanged();
    },
    []
  );

  const updateSelectedDevelopmentPlacement = useCallback(
    (
      field: 'x' | 'y' | 'depth' | 'originX' | 'originY' | 'scale' | 'scaleX' | 'scaleY' | 'alpha' | 'count' | 'spacing',
      value: string
    ) => {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) return;
      const next = {
        ...selectedDevPlacement,
        [field]: numericValue,
      };
      if (field === 'scaleX' || field === 'scaleY') {
        next.scaleX = field === 'scaleX'
          ? numericValue
          : selectedDevPlacement.scaleX ?? selectedDevPlacement.scale ?? 1;
        next.scaleY = field === 'scaleY'
          ? numericValue
          : selectedDevPlacement.scaleY ?? selectedDevPlacement.scale ?? 1;
        delete next.scale;
      }
      if (field === 'scale') {
        delete next.scaleX;
        delete next.scaleY;
      }
      if (field === 'count') {
        next.count = Math.max(1, Math.min(12, Math.round(numericValue)));
      }
      setSelectedDevPlacement(next);
      writeSelectedDevelopmentPlacement(next);
      if (
        next.id !== QORTAL_LAND_DEVELOPMENT_CLUB_FLOOR_PLACEMENT_ID &&
        next.id !== QORTAL_LAND_DEVELOPMENT_BACK_WALL_PLACEMENT_ID &&
        next.id !== QORTAL_LAND_DEVELOPMENT_LEFT_WALL_PLACEMENT_ID &&
        next.id !== QORTAL_LAND_DEVELOPMENT_RIGHT_WALL_PLACEMENT_ID &&
        next.id !== QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_PLACEMENT_ID &&
        !devPngPropsEnabled
      ) {
        window.localStorage.setItem(QORTAL_LAND_DEV_PNG_PROPS_STORAGE_KEY, '1');
        setDevPngPropsEnabled(true);
      }
    },
    [devPngPropsEnabled, selectedDevPlacement, writeSelectedDevelopmentPlacement]
  );

  const updateSelectedDevelopmentWarp = useCallback(
    (
      field: 'tlX' | 'tlY' | 'trX' | 'trY' | 'brX' | 'brY' | 'blX' | 'blY',
      value: string
    ) => {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) return;
      const next = {
        ...selectedDevPlacement,
        warp: {
          ...(selectedDevPlacement.warp ?? {}),
          [field]: numericValue,
        },
      };
      setSelectedDevPlacement(next);
      writeSelectedDevelopmentPlacement(next);
    },
    [selectedDevPlacement, writeSelectedDevelopmentPlacement]
  );

  const resetSelectedDevelopmentPlacement = useCallback(() => {
    const meta = getQortalLandEditableDevelopmentPlacement(selectedDevPlacementId);
    clearQortalLandDevelopmentPngPlacementOverride(meta.defaultPlacement.id);
    setSelectedDevPlacement({ ...meta.defaultPlacement });
    notifyQortalLandDevelopmentAssetsChanged();
  }, [selectedDevPlacementId]);

  const setProceduralClubShellVisible = useCallback((enabled: boolean) => {
    if (enabled) {
      window.localStorage.removeItem(QORTAL_LAND_DEV_PROCEDURAL_CLUB_SHELL_STORAGE_KEY);
    } else {
      window.localStorage.setItem(QORTAL_LAND_DEV_PROCEDURAL_CLUB_SHELL_STORAGE_KEY, '0');
    }
    setProceduralClubShellEnabled(enabled);
    notifyQortalLandDevelopmentAssetsChanged();
  }, []);

  const setCollisionDebugVisible = useCallback((enabled: boolean) => {
    if (enabled) {
      window.localStorage.setItem(QORTAL_LAND_DEV_COLLISION_DEBUG_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(QORTAL_LAND_DEV_COLLISION_DEBUG_STORAGE_KEY);
    }
    setCollisionDebugEnabled(enabled);
    notifyQortalLandDevelopmentAssetsChanged();
  }, []);

  const writeDevelopmentLookSettings = useCallback(
    (settings: QortalLandDevelopmentLookSettings) => {
      writeQortalLandDevelopmentLookSettings(settings);
      setDevelopmentLookSettings(settings);
      notifyQortalLandDevelopmentAssetsChanged();
    },
    []
  );

  const setDevelopmentLookEnabled = useCallback(
    (enabled: boolean) => {
      writeDevelopmentLookSettings({
        ...developmentLookSettings,
        enabled,
      });
    },
    [developmentLookSettings, writeDevelopmentLookSettings]
  );

  const updateDevelopmentLookSetting = useCallback(
    (
      field: 'brightness' | 'contrast' | 'saturation' | 'shadow',
      value: string
    ) => {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) return;
      const limits = {
        brightness: { min: 0.65, max: 1.25 },
        contrast: { min: 0.75, max: 1.55 },
        saturation: { min: 0.75, max: 1.65 },
        shadow: { min: 0, max: 0.5 },
      }[field];
      writeDevelopmentLookSettings({
        ...developmentLookSettings,
        [field]: clampQortalLandLookValue(
          numericValue,
          limits.min,
          limits.max,
          QORTAL_LAND_DEVELOPMENT_LOOK_DEFAULTS[field]
        ),
      });
    },
    [developmentLookSettings, writeDevelopmentLookSettings]
  );

  const resetDevelopmentLookSettings = useCallback(() => {
    writeDevelopmentLookSettings({ ...QORTAL_LAND_DEVELOPMENT_LOOK_DEFAULTS });
  }, [writeDevelopmentLookSettings]);

  const updateDevelopmentClubBarPlacement = useCallback(
    (
      field: 'x' | 'y' | 'depth' | 'originX' | 'originY' | 'scaleX' | 'scaleY',
      value: string
    ) => {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) return;
      const next = {
        ...devClubBarPlacement,
        [field]: numericValue,
      };
      if (field === 'scaleX' || field === 'scaleY') {
        next.scaleX = field === 'scaleX'
          ? numericValue
          : devClubBarPlacement.scaleX ?? devClubBarPlacement.scale ?? 1;
        next.scaleY = field === 'scaleY'
          ? numericValue
          : devClubBarPlacement.scaleY ?? devClubBarPlacement.scale ?? 1;
        delete next.scale;
      }
      setDevClubBarPlacement(next);
      writeQortalLandDevelopmentPngPlacementOverride(
        QORTAL_LAND_DEVELOPMENT_CLUB_BAR_PLACEMENT_ID,
        {
          x: next.x,
          y: next.y,
          depth: next.depth,
          originX: next.originX,
          originY: next.originY,
          scaleX: next.scaleX,
          scaleY: next.scaleY,
          scale: next.scaleX === undefined && next.scaleY === undefined ? next.scale : undefined,
        }
      );
      if (!devPngPropsEnabled) {
        window.localStorage.setItem(QORTAL_LAND_DEV_PNG_PROPS_STORAGE_KEY, '1');
        setDevPngPropsEnabled(true);
      }
      notifyQortalLandDevelopmentAssetsChanged();
    },
    [devClubBarPlacement, devPngPropsEnabled]
  );

  const resetDevelopmentClubBarPlacement = useCallback(() => {
    clearQortalLandDevelopmentPngPlacementOverride(
      QORTAL_LAND_DEVELOPMENT_CLUB_BAR_PLACEMENT_ID
    );
    const defaults = { ...QORTAL_LAND_DEVELOPMENT_CLUB_BAR_DEFAULT_PLACEMENT };
    setDevClubBarPlacement(defaults);
    notifyQortalLandDevelopmentAssetsChanged();
  }, []);

  const updateDevelopmentBackBarPlacement = useCallback(
    (
      field: 'x' | 'y' | 'depth' | 'originX' | 'originY' | 'scale',
      value: string
    ) => {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) return;
      const next = {
        ...devBackBarPlacement,
        [field]: numericValue,
      };
      setDevBackBarPlacement(next);
      writeQortalLandDevelopmentPngPlacementOverride(
        QORTAL_LAND_DEVELOPMENT_BACK_BAR_PLACEMENT_ID,
        {
          x: next.x,
          y: next.y,
          depth: next.depth,
          originX: next.originX,
          originY: next.originY,
          scale: next.scale,
        }
      );
      if (!devPngPropsEnabled) {
        window.localStorage.setItem(QORTAL_LAND_DEV_PNG_PROPS_STORAGE_KEY, '1');
        setDevPngPropsEnabled(true);
      }
      notifyQortalLandDevelopmentAssetsChanged();
    },
    [devBackBarPlacement, devPngPropsEnabled]
  );

  const resetDevelopmentBackBarPlacement = useCallback(() => {
    clearQortalLandDevelopmentPngPlacementOverride(
      QORTAL_LAND_DEVELOPMENT_BACK_BAR_PLACEMENT_ID
    );
    const defaults = { ...QORTAL_LAND_DEVELOPMENT_BACK_BAR_DEFAULT_PLACEMENT };
    setDevBackBarPlacement(defaults);
    notifyQortalLandDevelopmentAssetsChanged();
  }, []);

  const updateDevelopmentDjBoothPlacement = useCallback(
    (
      field: 'x' | 'y' | 'depth' | 'originX' | 'originY' | 'scale',
      value: string
    ) => {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) return;
      const next = {
        ...devDjBoothPlacement,
        [field]: numericValue,
      };
      setDevDjBoothPlacement(next);
      writeQortalLandDevelopmentPngPlacementOverride(
        QORTAL_LAND_DEVELOPMENT_DJ_BOOTH_PLACEMENT_ID,
        {
          x: next.x,
          y: next.y,
          depth: next.depth,
          originX: next.originX,
          originY: next.originY,
          scale: next.scale,
        }
      );
      if (!devPngPropsEnabled) {
        window.localStorage.setItem(QORTAL_LAND_DEV_PNG_PROPS_STORAGE_KEY, '1');
        setDevPngPropsEnabled(true);
      }
      notifyQortalLandDevelopmentAssetsChanged();
    },
    [devDjBoothPlacement, devPngPropsEnabled]
  );

  const resetDevelopmentDjBoothPlacement = useCallback(() => {
    clearQortalLandDevelopmentPngPlacementOverride(
      QORTAL_LAND_DEVELOPMENT_DJ_BOOTH_PLACEMENT_ID
    );
    const defaults = { ...QORTAL_LAND_DEVELOPMENT_DJ_BOOTH_DEFAULT_PLACEMENT };
    setDevDjBoothPlacement(defaults);
    notifyQortalLandDevelopmentAssetsChanged();
  }, []);

  const queuePrimaryNameLookups = useCallback((addresses: string[]) => {
    const missingAddresses = addresses
      .map((address) => address.trim())
      .filter((address) => {
        if (!address) return false;
        if (primaryNameCacheRef.current.has(address)) return false;
        if (pendingPrimaryNameLookupsRef.current.has(address)) return false;
        return true;
      });
    if (missingAddresses.length === 0) return;

    missingAddresses.forEach((address) => pendingPrimaryNameLookupsRef.current.add(address));
    if (primaryNameLookupTimerRef.current !== null) return;

    primaryNameLookupTimerRef.current = window.setTimeout(() => {
      primaryNameLookupTimerRef.current = null;
      const batch = Array.from(pendingPrimaryNameLookupsRef.current);
      pendingPrimaryNameLookupsRef.current.clear();
      if (batch.length === 0) return;

      void getPrimaryNamesForAddresses(batch)
        .then((primaryNames) => {
          batch.forEach((address) => {
            primaryNameCacheRef.current.set(address, primaryNames[address]?.trim() || '');
          });
        })
        .catch((error) => {
          console.error('[QortalLand] Failed to resolve primary names:', error);
        });
    }, 120);
  }, []);

  useEffect(() => {
    queuePrimaryNameLookups([myAddress]);
  }, [myAddress, queuePrimaryNameLookups]);

  useEffect(() => {
    return () => {
      if (primaryNameLookupTimerRef.current !== null) {
        window.clearTimeout(primaryNameLookupTimerRef.current);
        primaryNameLookupTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.reticulumChat?.isEnabled?.().then((enabled) => {
      if (!cancelled) setReticulumReady(enabled === true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const pressedKeys = movementKeysRef.current;
    const normalizeMovementKey = (key: string): string => key.trim().toLowerCase();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const key = normalizeMovementKey(event.key);
      if (key === 'e' && isNearClubDjBooth(localStateRef.current.roomId, localStateRef.current.x, localStateRef.current.y)) {
        event.preventDefault();
        return;
      }
      if (!['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'w', 's'].includes(key)) return;
      pressedKeys.add(key);
      event.preventDefault();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      pressedKeys.delete(normalizeMovementKey(event.key));
    };
    const clearKeys = () => {
      pressedKeys.clear();
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', clearKeys);
    document.addEventListener('visibilitychange', clearKeys);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', clearKeys);
      document.removeEventListener('visibilitychange', clearKeys);
      clearKeys();
    };
  }, []);

  const sendLandChat = useCallback(async () => {
    if (isSendingChat || reticulumReady !== true) return;
    const text = chatText.trim().replace(/\s+/g, ' ');
    if (!text) return;
    if (utf8ByteLength(text) > LAND_CHAT_MAX_TEXT_BYTES) {
      setChatError('Message is too large');
      return;
    }
    setIsSendingChat(true);
    setChatError('');
    try {
      const timestamp = Date.now();
      const eventId = createLandChatMessageId();
      const syncState = await window.reticulumChat?.getSyncState?.(groupId);
      const latestAuthorSeq = Math.max(
        chatAuthorSeqRef.current,
        Number(syncState?.[myAddress] ?? 0) || 0
      );
      const authorSeq = latestAuthorSeq + 1;
      const landSequence = landChatSequenceRef.current + 1;
      landChatSequenceRef.current = landSequence;
      const encryptedPayload = JSON.stringify({
        messageText: text,
        qortalLand: true,
        sessionId,
        landSequence,
        version: 1,
      });
      const payloadHash = await sha256Hex(encryptedPayload);
      const baseFields = {
        eventId,
        groupId,
        channelId: QORTAL_LAND_CHANNEL_ID,
        authorSeq,
        timestamp,
        eventType: 'message',
        targetEventId: null,
        replyToEventId: null,
        encryptedPayload,
        payloadHash,
        mentionAddressHashes: [],
      };
      const signed = await window.sendMessage?.('signReticulumChatEvent', baseFields, 10000) as
        | {
            authorAddress?: string;
            authorPublicKey?: string;
            signature?: string;
            error?: string;
          }
        | undefined;
      if (!signed || signed.error) {
        throw new Error(signed?.error || 'Unable to sign QortalLand chat');
      }
      if (signed.authorAddress !== myAddress) {
        throw new Error('Signed QortalLand chat author mismatch');
      }
      const result = await window.reticulumChat?.publishEvent?.({
        ...baseFields,
        authorAddress: signed.authorAddress,
        authorPublicKey: signed.authorPublicKey,
        signature: signed.signature,
      });
      if (!result?.success) {
        throw new Error(result?.error || 'QortalLand chat send failed');
      }
      chatAuthorSeqRef.current = authorSeq;
      setChatText('');
      if (isEditableTarget(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'QortalLand chat send failed');
    } finally {
      setIsSendingChat(false);
    }
  }, [chatText, groupId, isSendingChat, myAddress, reticulumReady, sessionId]);

  useEffect(() => {
    if (!Number.isInteger(groupId) || groupId <= 0 || !myAddress) return;
    void window.reticulumChat?.subscribeGroup?.(groupId);
    void window.reticulumChat?.subscribeChannel?.(groupId, QORTAL_LAND_CHANNEL_ID);
    const unsubscribe = window.reticulumChat?.onLandState?.((payload) => {
      if (payload.groupId !== groupId) return;
      if (payload.authorAddress === myAddress && payload.sessionId === sessionId) return;
      queuePrimaryNameLookups([payload.authorAddress]);
      const key = `${payload.authorAddress}:${payload.sessionId}`;
      const existing = remotePlayersRef.current.get(key);
      const now = Date.now();
      const roomId = normalizeLandRoomId(payload.roomId);
      if (payload.movement === 'leave') {
        if (!existing || payload.sequence >= existing.sequence) {
          remotePlayersRef.current.delete(key);
        }
        return;
      }
      if (existing && payload.sequence <= existing.sequence) {
        existing.lastSeenAt = now;
        return;
      }
      const sentAt = finiteNumber(payload.timestamp) ?? now;
      const roomChanged = Boolean(existing && existing.roomId !== roomId);
      const fromX = roomChanged ? payload.x : existing?.displayX ?? existing?.x ?? payload.x;
      const fromY = roomChanged ? payload.y : existing?.displayY ?? existing?.y ?? payload.y;
      const stateGapMs = existing
        ? clampNumber(
            sentAt > existing.sentAt ? sentAt - existing.sentAt : now - existing.receivedAt,
            LAND_SEND_INTERVAL_MS,
            5000
          )
        : LAND_SEND_INTERVAL_MS;
      const velocitySourceMs = Math.max(stateGapMs, 1);
      const velocityX = existing && !roomChanged
        ? clampRemoteVelocity((payload.x - existing.x) / velocitySourceMs)
        : 0;
      const velocityY = existing && !roomChanged
        ? clampRemoteVelocity((payload.y - existing.y) / velocitySourceMs)
        : 0;
      const distance = Math.hypot(payload.x - fromX, payload.y - fromY);
      remotePlayersRef.current.set(key, {
        authorAddress: payload.authorAddress,
        sessionId: payload.sessionId,
        sequence: payload.sequence,
        roomId,
        x: payload.x,
        y: payload.y,
        fromX,
        fromY,
        displayX: fromX,
        displayY: fromY,
        direction: payload.direction || existing?.direction || 'r',
        movement: payload.movement || 'idle',
        sentAt,
        receivedAt: now,
        lastSeenAt: now,
        interpolationMs: estimateRemoteInterpolationMs(distance, stateGapMs),
        velocityX,
        velocityY,
      });
    });
    return () => {
      unsubscribe?.();
      void window.reticulumChat?.unsubscribeChannel?.(groupId, QORTAL_LAND_CHANNEL_ID);
      void window.reticulumChat?.sendLandState?.(groupId, myAddress, {
        sessionId,
        sequence: sequenceRef.current + 1,
        ...localStateRef.current,
        movement: 'leave',
      });
    };
  }, [groupId, myAddress, queuePrimaryNameLookups, sessionId]);

  useEffect(() => {
    if (!Number.isInteger(groupId) || groupId <= 0 || !myAddress) return;
    const unsubscribe = window.reticulumChat?.onEvent?.(({ event }) => {
      const payload = event as ReticulumChatEventForLand;
      if (Number(payload.groupId) !== groupId) return;
      if (payload.channelId !== QORTAL_LAND_CHANNEL_ID) return;
      if (payload.eventType !== 'message') return;
      if (
        typeof payload.eventId !== 'string' ||
        typeof payload.authorAddress !== 'string' ||
        typeof payload.encryptedPayload !== 'string'
      ) {
        return;
      }
      let decoded: Record<string, unknown>;
      try {
        decoded = JSON.parse(payload.encryptedPayload) as Record<string, unknown>;
      } catch {
        return;
      }
      if (decoded.qortalLand !== true) return;
      const text = String(decoded.messageText || decoded.message || '').trim();
      if (!text) return;
      const session = typeof decoded.sessionId === 'string' ? decoded.sessionId : sessionId;
      const sequence = Number(decoded.landSequence);
      queuePrimaryNameLookups([payload.authorAddress]);
      const now = Date.now();
      landChatBubblesRef.current.set(payload.eventId, {
        messageId: payload.eventId,
        authorAddress: payload.authorAddress,
        sessionId: session,
        sequence: Number.isFinite(sequence) ? sequence : 0,
        text,
        createdAt: now,
        expiresAt: now + LAND_CHAT_BUBBLE_TTL_MS,
      });
    });
    return () => {
      unsubscribe?.();
    };
  }, [groupId, myAddress, queuePrimaryNameLookups, sessionId]);


  useEffect(() => {
    if (reticulumReady !== true || !Number.isInteger(groupId) || groupId <= 0 || !myAddress) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      const current = localStateRef.current;
      const previous = lastSentRef.current;
      const moved =
        Math.abs(current.x - previous.x) >= 2 ||
        Math.abs(current.y - previous.y) >= 2 ||
        current.direction !== previous.direction ||
        current.movement !== previous.movement;
      if (!moved && now - previous.sentAt < LAND_HEARTBEAT_MS) return;
      sequenceRef.current += 1;
      lastSentRef.current = { ...current, sentAt: now };
      void window.reticulumChat?.sendLandState?.(groupId, myAddress, {
        sessionId,
        sequence: sequenceRef.current,
        ...current,
      });
    }, LAND_SEND_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [groupId, myAddress, reticulumReady, sessionId]);

  useEffect(() => {
    if (!containerRef.current || !myAddress) return;
    let destroyed = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeFrame = 0;
    let removeWindowResizeListener: (() => void) | null = null;

    void import('phaser').then((Phaser) => {
      if (destroyed || !containerRef.current) return;
      const localHue = addressHue(myAddress);
      const localColor = Phaser.Display.Color.HSLToColor(localHue / 360, 0.62, 0.58).color;
      const remoteHueBase = (localHue + 145) % 360;

      class QortalLandScene extends Phaser.Scene {
        private localAvatar?: any;
        private localLabel?: any;
        private remotes = new Map<string, any>();
        private remoteLabels = new Map<string, any>();
        private chatBubbles = new Map<string, { container: any; background: any; text: any }>();
        private background?: any;
        private lightSweep?: any;
        private foreground?: any;
        private interactionPrompt?: { container: any; background: any; text: any };
        private propLayers: any[] = [];
        private developmentPngPropSprites: any[] = [];
        private developmentLookTextureKeys = new Set<string>();
        private clubSkywalkDoor?: {
          closed: any;
          semiOpen: any;
          open: any;
          progress: number;
          targetProgress: number;
          baseAlpha: number;
          baseScaleX: number;
          baseScaleY: number;
          hotspotX: number;
          hotspotY: number;
          proximityRadius: number;
          passMinX: number;
          passMaxX: number;
          passMinY: number;
          passMaxY: number;
          returnX: number;
          returnY: number;
          left: number;
          right: number;
          top: number;
          bottom: number;
        };

        constructor() {
          super('QortalLandScene');
        }

        private handleDevelopmentAssetsChanged = () => {
          this.drawWorld();
          this.updateCameraLayout();
          this.updateInteractionPrompt();
        };

        private handleSceneResize = () => {
          this.drawWorld();
          this.updateCameraLayout();
          this.updateInteractionPrompt();
        };

        private updateCameraLayout() {
          const camera = this.cameras.main;
          const roomSize = roomSizeForRoom(currentRoomRef.current);
          const viewportWidth = Math.max(1, Number(this.scale.width) || camera.width || roomSize.width);
          const viewportHeight = Math.max(1, Number(this.scale.height) || camera.height || roomSize.height);
          const avatarLogicalX = Number(this.localAvatar?.getData?.('logicalX'));
          const avatarLogicalY = Number(this.localAvatar?.getData?.('logicalY'));
          const targetX = Number.isFinite(avatarLogicalX)
            ? avatarLogicalX
            : localStateRef.current.x ?? roomSize.width / 2;
          const targetY = Number.isFinite(avatarLogicalY)
            ? avatarLogicalY
            : localStateRef.current.y ?? roomSize.height / 2;
          const horizontalPadding = Math.max(0, (viewportWidth - roomSize.width) / 2);
          const verticalPadding = Math.max(0, (viewportHeight - roomSize.height) / 2);
          const scrollX = horizontalPadding > 0
            ? -horizontalPadding
            : Phaser.Math.Clamp(targetX - viewportWidth / 2, 0, roomSize.width - viewportWidth);
          const scrollY = verticalPadding > 0
            ? -verticalPadding
            : Phaser.Math.Clamp(targetY - viewportHeight / 2, 0, roomSize.height - viewportHeight);

          camera.stopFollow();
          camera.setBackgroundColor('#050811');
          camera.setZoom(1);
          camera.setBounds(
            -horizontalPadding,
            -verticalPadding,
            roomSize.width + horizontalPadding * 2,
            roomSize.height + verticalPadding * 2
          );
          camera.setScroll(scrollX, scrollY);
        };

        preload() {
          this.load.spritesheet(LAND_CHARACTER_SPRITESHEET_KEY, defaultCharacterSpritesheetUrl, {
            frameWidth: LAND_CHARACTER_FRAME_SIZE,
            frameHeight: LAND_CHARACTER_FRAME_SIZE,
          });
          qortalLandDevelopmentPngAssets.forEach((asset) => {
            const textureKey = qortalLandDevelopmentPngTextureKey(asset.id);
            if (!this.textures.exists(textureKey)) {
              this.load.image(textureKey, asset.url);
            }
          });
        }

        create() {
          currentRoomRef.current = localStateRef.current.roomId;
          const startRoomSize = roomSizeForRoom(currentRoomRef.current);
          this.cameras.main.setBounds(0, 0, startRoomSize.width, startRoomSize.height);
          this.ensureCharacterAnimations();
          this.drawWorld();
          const start = localStateRef.current;
          const startScale = characterScaleForRoomY(start.roomId, start.y);
          this.localAvatar = this.createAvatar(start.x, start.y, localColor, true);
          this.localLabel = this.add
            .text(
              start.x,
              start.y - LAND_CHARACTER_LABEL_OFFSET * startScale,
              displayNameForAddress(myAddress, primaryNameCacheRef.current),
              {
              color: '#f8fbff',
              fontFamily: 'Inter, Arial, sans-serif',
              fontSize: '12px',
              stroke: '#10151c',
              strokeThickness: 4,
              }
            )
            .setOrigin(0.5);
          this.localAvatar.setScale(startScale);
          this.localAvatar.setDepth(start.y + 20);
          this.localLabel.setDepth(start.y + 90);
          this.interactionPrompt = this.createInteractionPrompt();
          this.updateInteractionPrompt();
          this.updateCameraLayout();
          this.scale.on('resize', this.handleSceneResize, this);
          window.addEventListener(
            QORTAL_LAND_DEV_ASSETS_CHANGED_EVENT,
            this.handleDevelopmentAssetsChanged
          );
          const removeDevelopmentAssetListener = () => {
            this.scale.off('resize', this.handleSceneResize, this);
            window.removeEventListener(
              QORTAL_LAND_DEV_ASSETS_CHANGED_EVENT,
              this.handleDevelopmentAssetsChanged
            );
          };
          this.events.once('shutdown', removeDevelopmentAssetListener);
          this.events.once('destroy', removeDevelopmentAssetListener);
        }

        update(time: number, delta: number) {
          this.animateRoom(time);
          this.updateLocalPlayer(delta);
          this.updateClubSkywalkDoor(delta);
          this.updateCameraLayout();
          this.updateInteractionPrompt();
          this.updateRemotePlayers();
          try {
            this.updateChatBubbles();
          } catch (error) {
            console.warn('[QortalLand] Chat bubble update failed', error);
            landChatBubblesRef.current.clear();
            for (const [messageId, bubbleObjects] of this.chatBubbles.entries()) {
              this.removeChatBubble(messageId, bubbleObjects);
            }
          }
        }

        private drawWorld() {
          this.background?.destroy();
          this.lightSweep?.destroy();
          this.foreground?.destroy();
          this.propLayers.forEach((layer) => layer.destroy());
          this.developmentPngPropSprites.forEach((sprite) => sprite.destroy());
          this.developmentLookTextureKeys.forEach((textureKey) => {
            if (this.textures.exists(textureKey)) {
              this.textures.remove(textureKey);
            }
          });
          this.propLayers = [];
          this.developmentPngPropSprites = [];
          this.developmentLookTextureKeys.clear();
          this.clubSkywalkDoor = undefined;
          const g = this.add.graphics();
          const roomId = currentRoomRef.current;
          if (roomId === QORTAL_LAND_SKYWALK_ROOM_ID) {
            this.drawSkywalkWorld(g);
            this.background = g;
            g.setDepth(-100);
            this.drawSkywalkDepthProps();
            this.drawDevelopmentPngProps();
            this.drawCollisionDebug();
            this.lightSweep = this.add.graphics();
            this.lightSweep.setDepth(-80);
            this.foreground = this.add.graphics();
            this.drawForeground(this.foreground);
            this.foreground.setDepth(roomFloorRange(roomId).bottom + 170);
            return;
          }
          if (roomId === QORTAL_LAND_MALL_ROOM_ID) {
            this.drawMallWorld(g);
            this.background = g;
            g.setDepth(-100);
            this.drawMallDepthProps();
            this.drawDevelopmentPngProps();
            this.drawCollisionDebug();
            this.lightSweep = this.add.graphics();
            this.lightSweep.setDepth(-80);
            this.foreground = this.add.graphics();
            this.drawForeground(this.foreground);
            this.foreground.setDepth(roomFloorRange(roomId).bottom + 170);
            return;
          }
          if (roomId === QORTAL_LAND_PARK_ROOM_ID) {
            this.drawParkWorld(g);
            this.background = g;
            g.setDepth(-100);
            this.drawParkDepthProps();
            this.drawDevelopmentPngProps();
            this.drawCollisionDebug();
            this.lightSweep = this.add.graphics();
            this.lightSweep.setDepth(-80);
            this.foreground = this.add.graphics();
            this.drawForeground(this.foreground);
            this.foreground.setDepth(roomFloorRange(roomId).bottom + 170);
            return;
          }
          const layout = roomLayoutForRoom(roomId);
          const { floor } = layout;
          const showProceduralClubShell = shouldShowQortalLandProceduralClubShell();

          g.fillStyle(0x070914, 1);
          g.fillRect(0, 0, layout.width, layout.height);
          if (showProceduralClubShell) {
            g.fillStyle(0x10152a, 1);
            g.fillRect(0, 0, layout.width, floor.topY);
            this.drawSideWalls(g);
            this.drawCeilingRig(g);

            g.fillStyle(0x0c0d19, 1);
            g.fillPoints([
              new Phaser.Geom.Point(floor.back.minX, floor.topY),
              new Phaser.Geom.Point(floor.back.maxX, floor.topY),
              new Phaser.Geom.Point(floor.front.maxX, floor.bottomY),
              new Phaser.Geom.Point(floor.front.minX, floor.bottomY),
            ], true);
            g.lineStyle(3, 0x1be7ff, 0.16);
            g.strokePoints([
              new Phaser.Geom.Point(floor.back.minX, floor.topY),
              new Phaser.Geom.Point(floor.back.maxX, floor.topY),
              new Phaser.Geom.Point(floor.front.maxX, floor.bottomY),
              new Phaser.Geom.Point(floor.front.minX, floor.bottomY),
              new Phaser.Geom.Point(floor.back.minX, floor.topY),
            ], false);

            this.drawFloorTexture(g);
            g.lineStyle(1, 0x00e7ff, 0.055);
            for (let i = 1; i <= 4; i += 1) {
              const t = i / 5;
              const leftX = floor.back.minX + (floor.front.minX - floor.back.minX) * t;
              const rightX = floor.back.maxX + (floor.front.maxX - floor.back.maxX) * t;
              const y = floor.topY + t * (floor.bottomY - floor.topY);
              g.lineBetween(leftX, y, rightX, y);
            }
            for (let i = 1; i <= 6; i += 1) {
              const t = i / 7;
              const topX = floor.back.minX + t * (floor.back.maxX - floor.back.minX);
              const bottomX = floor.front.minX + t * (floor.front.maxX - floor.front.minX);
              g.lineBetween(topX, floor.topY, bottomX, floor.bottomY);
            }

            if (!this.hasClubSkywalkDoorPng()) {
              this.drawSkywalkDoor(g, 1478, 118);
            }
          }
          this.background = g;
          g.setDepth(-100);

          this.drawClubBackWallPng();
          this.drawClubSideWallPng(QORTAL_LAND_DEVELOPMENT_LEFT_WALL_DEFAULT_PLACEMENT);
          this.drawClubSideWallPng(QORTAL_LAND_DEVELOPMENT_RIGHT_WALL_DEFAULT_PLACEMENT);
          this.drawClubSkywalkDoorPng();
          this.drawClubFloorPng();
          this.drawDepthProps();
          this.drawDevelopmentPngProps();
          this.drawCollisionDebug();
          this.lightSweep = this.add.graphics();
          this.lightSweep.setDepth(-80);
          if (showProceduralClubShell) {
            this.foreground = this.add.graphics();
            this.drawForeground(this.foreground);
            this.foreground.setDepth(floor.bottomY + 170);
          }
        }

        private drawClubFloorPng() {
          const placement = getQortalLandDevelopmentPlacement(
            QORTAL_LAND_DEVELOPMENT_CLUB_FLOOR_DEFAULT_PLACEMENT
          );
          const asset = qortalLandDevelopmentPngAssetById.get(
            placement.assetId
          );
          if (!asset) return;
          const textureKey = qortalLandDevelopmentPngTextureKey(asset.id);
          if (!this.textures.exists(textureKey)) return;
          const lookTextureKey = this.developmentLookTextureKeyForPlacement(placement, textureKey);
          const sprite = this.add.image(placement.x, placement.y, lookTextureKey);
          sprite.setName('club.floor_png');
          sprite.setOrigin(placement.originX ?? 0, placement.originY ?? 0);
          sprite.setScale(
            placement.scaleX ?? placement.scale ?? 1,
            placement.scaleY ?? placement.scale ?? 1
          );
          sprite.setAlpha(placement.alpha ?? 1);
          sprite.setDepth(placement.depth ?? -95);
          this.developmentPngPropSprites.push(sprite);
        }

        private drawClubBackWallPng() {
          const placement = getQortalLandDevelopmentPlacement(
            QORTAL_LAND_DEVELOPMENT_BACK_WALL_DEFAULT_PLACEMENT
          );
          const asset = qortalLandDevelopmentPngAssetById.get(
            placement.assetId
          );
          if (!asset) return;
          const textureKey = qortalLandDevelopmentPngTextureKey(asset.id);
          if (!this.textures.exists(textureKey)) return;
          const lookTextureKey = this.developmentLookTextureKeyForPlacement(placement, textureKey);
          const sprite = this.add.image(placement.x, placement.y, lookTextureKey);
          sprite.setName('club.back_wall_main_png');
          sprite.setOrigin(placement.originX ?? 0.5, placement.originY ?? 1);
          sprite.setScale(
            placement.scaleX ?? placement.scale ?? 1,
            placement.scaleY ?? placement.scale ?? 1
          );
          sprite.setAlpha(placement.alpha ?? 1);
          sprite.setDepth(placement.depth ?? -96);
          this.developmentPngPropSprites.push(sprite);
        }

        private drawClubSideWallPng(defaultPlacement: QortalLandDevelopmentPngPropPlacement) {
          const placement = getQortalLandDevelopmentPlacement(defaultPlacement);
          const asset = qortalLandDevelopmentPngAssetById.get(
            placement.assetId
          );
          if (!asset) return;
          const textureKey = qortalLandDevelopmentPngTextureKey(asset.id);
          if (!this.textures.exists(textureKey)) return;
          const lookTextureKey = this.developmentLookTextureKeyForPlacement(placement, textureKey);
          const sprite = this.add.image(placement.x, placement.y, lookTextureKey);
          sprite.setName(placement.id);
          sprite.setOrigin(placement.originX ?? 0.5, placement.originY ?? 0);
          sprite.setScale(
            placement.scaleX ?? placement.scale ?? 1,
            placement.scaleY ?? placement.scale ?? 1
          );
          sprite.setAlpha(placement.alpha ?? 1);
          sprite.setDepth(placement.depth ?? -98);
          this.developmentPngPropSprites.push(sprite);
        }

        private hasClubSkywalkDoorPng() {
          return QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_ASSET_IDS.every((assetId) => {
            const asset = qortalLandDevelopmentPngAssetById.get(assetId);
            return asset && this.textures.exists(qortalLandDevelopmentPngTextureKey(asset.id));
          });
        }

        private hasWarpOffset(warp?: QortalLandDevelopmentPngPropPlacement['warp']) {
          if (!warp) return false;
          return ['tlX', 'tlY', 'trX', 'trY', 'brX', 'brY', 'blX', 'blY'].some((key) => {
            const value = warp[key as keyof NonNullable<QortalLandDevelopmentPngPropPlacement['warp']>];
            return Number.isFinite(value) && Math.abs(Number(value)) > 0.001;
          });
        }

        private developmentLookTextureKeyForPlacement(
          placement: QortalLandDevelopmentPngPropPlacement,
          textureKey: string
        ): string {
          const settings = readQortalLandDevelopmentLookSettings();
          if (!settings.enabled || shouldSkipQortalLandDevelopmentLook(placement)) {
            return textureKey;
          }
          const frame = this.textures.getFrame(textureKey) as any;
          const sourceImage = frame?.source?.image as CanvasImageSource | undefined;
          if (!sourceImage) return textureKey;
          const width = Math.max(1, Math.floor(frame.width ?? 1));
          const height = Math.max(1, Math.floor(frame.height ?? 1));
          const adjustedTextureKey = `${textureKey}:look:${qortalLandDevelopmentLookSignature(settings)}`;
          if (this.textures.exists(adjustedTextureKey)) {
            this.developmentLookTextureKeys.add(adjustedTextureKey);
            return adjustedTextureKey;
          }
          const canvasTexture = this.textures.createCanvas(
            adjustedTextureKey,
            width,
            height
          ) as any;
          const context = canvasTexture?.getContext?.() as CanvasRenderingContext2D | undefined;
          if (!canvasTexture || !context) return textureKey;
          context.clearRect(0, 0, width, height);
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = 'high';
          context.drawImage(
            sourceImage,
            frame.cutX,
            frame.cutY,
            width,
            height,
            0,
            0,
            width,
            height
          );
          try {
            const imageData = context.getImageData(0, 0, width, height);
            const data = imageData.data;
            const brightness = settings.brightness;
            const contrast = settings.contrast;
            const saturation = settings.saturation;
            const shadow = settings.shadow;
            for (let index = 0; index < data.length; index += 4) {
              const alpha = data[index + 3];
              if (alpha === 0) continue;
              let red = data[index] / 255;
              let green = data[index + 1] / 255;
              let blue = data[index + 2] / 255;
              const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
              if (luminance < 0.58 && shadow > 0) {
                const shadowWeight = 1 - shadow * (1 - luminance / 0.58);
                red *= shadowWeight;
                green *= shadowWeight;
                blue *= shadowWeight;
              }
              const saturatedRed = luminance + (red - luminance) * saturation;
              const saturatedGreen = luminance + (green - luminance) * saturation;
              const saturatedBlue = luminance + (blue - luminance) * saturation;
              red = (saturatedRed - 0.5) * contrast + 0.5;
              green = (saturatedGreen - 0.5) * contrast + 0.5;
              blue = (saturatedBlue - 0.5) * contrast + 0.5;
              data[index] = Phaser.Math.Clamp(Math.round(red * brightness * 255), 0, 255);
              data[index + 1] = Phaser.Math.Clamp(Math.round(green * brightness * 255), 0, 255);
              data[index + 2] = Phaser.Math.Clamp(Math.round(blue * brightness * 255), 0, 255);
            }
            context.putImageData(imageData, 0, 0);
            canvasTexture.refresh?.();
            this.developmentLookTextureKeys.add(adjustedTextureKey);
            return adjustedTextureKey;
          } catch (error) {
            console.warn('[QortalLand] Development look texture failed', error);
            if (this.textures.exists(adjustedTextureKey)) {
              this.textures.remove(adjustedTextureKey);
            }
            return textureKey;
          }
        }

        private createWarpedDevelopmentPngTexture(
          placement: QortalLandDevelopmentPngPropPlacement,
          textureKey: string,
          index: number,
          width: number,
          height: number
        ): { textureKey: string; originX: number; originY: number } | null {
          const frame = this.textures.getFrame(textureKey) as any;
          const sourceImage = frame?.source?.image as CanvasImageSource | undefined;
          if (!sourceImage) return null;
          const warp = placement.warp ?? {};
          const maxWarpOffset = Math.max(80, Math.min(720, Math.max(width, height) * 0.55));
          const warpOffset = (value: number | undefined): number =>
            Math.max(-maxWarpOffset, Math.min(maxWarpOffset, Number(value) || 0));
          const points = {
            tl: { x: warpOffset(warp.tlX), y: warpOffset(warp.tlY) },
            tr: { x: width + warpOffset(warp.trX), y: warpOffset(warp.trY) },
            br: { x: width + warpOffset(warp.brX), y: height + warpOffset(warp.brY) },
            bl: { x: warpOffset(warp.blX), y: height + warpOffset(warp.blY) },
          };
          const minX = Math.min(points.tl.x, points.tr.x, points.br.x, points.bl.x);
          const minY = Math.min(points.tl.y, points.tr.y, points.br.y, points.bl.y);
          const maxX = Math.max(points.tl.x, points.tr.x, points.br.x, points.bl.x);
          const maxY = Math.max(points.tl.y, points.tr.y, points.br.y, points.bl.y);
          const canvasWidth = Math.max(1, Math.ceil(maxX - minX));
          const canvasHeight = Math.max(1, Math.ceil(maxY - minY));
          const warpedTextureKey = `${textureKey}:warp:${placement.id}:${index}`;
          if (this.textures.exists(warpedTextureKey)) {
            this.textures.remove(warpedTextureKey);
          }
          const canvasTexture = this.textures.createCanvas(
            warpedTextureKey,
            canvasWidth,
            canvasHeight
          ) as any;
          const context = canvasTexture?.getContext?.() as CanvasRenderingContext2D | undefined;
          if (!canvasTexture || !context) return null;
          context.clearRect(0, 0, canvasWidth, canvasHeight);
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = 'high';
          const sliceCount = Math.max(1, Math.ceil(height));
          for (let row = 0; row < sliceCount; row += 1) {
            const t = sliceCount === 1 ? 0 : row / (sliceCount - 1);
            const leftX = points.tl.x + (points.bl.x - points.tl.x) * t - minX;
            const leftY = points.tl.y + (points.bl.y - points.tl.y) * t - minY;
            const rightX = points.tr.x + (points.br.x - points.tr.x) * t - minX;
            const rightY = points.tr.y + (points.br.y - points.tr.y) * t - minY;
            const dx = rightX - leftX;
            const dy = rightY - leftY;
            const length = Math.max(1, Math.hypot(dx, dy));
            context.save();
            context.translate(leftX, leftY);
            context.rotate(Math.atan2(dy, dx));
            context.drawImage(
              sourceImage,
              frame.cutX,
              frame.cutY + Math.min(row, height - 1),
              width,
              1,
              0,
              0,
              length,
              1.35
            );
            context.restore();
          }
          canvasTexture.refresh?.();
          return {
            textureKey: warpedTextureKey,
            originX: ((placement.originX ?? 0.5) * width - minX) / canvasWidth,
            originY: ((placement.originY ?? 0.5) * height - minY) / canvasHeight,
          };
        }

        private createWarpableDevelopmentPng(
          placement: QortalLandDevelopmentPngPropPlacement,
          textureKey: string,
          index: number
        ) {
          const lookTextureKey = this.developmentLookTextureKeyForPlacement(placement, textureKey);
          const baseScaleX = placement.scaleX ?? placement.scale ?? 1;
          const baseScaleY = placement.scaleY ?? placement.scale ?? 1;
          const depth = placement.depth ?? -82;
          const baseAlpha = placement.alpha ?? 1;
          const frame = this.textures.getFrame(lookTextureKey);
          const width = frame?.width ?? 70;
          const height = frame?.height ?? 365;
          const originX = placement.originX ?? 0.5;
          const originY = placement.originY ?? 0.5;
          const warp = placement.warp ?? {};

          if (this.hasWarpOffset(warp)) {
            const warpedTexture = this.createWarpedDevelopmentPngTexture(
              placement,
              lookTextureKey,
              index,
              width,
              height
            );
            if (warpedTexture) {
              const sprite = this.add.image(placement.x, placement.y, warpedTexture.textureKey);
              sprite.setName(`${placement.id}:${index}`);
              sprite.setOrigin(warpedTexture.originX, warpedTexture.originY);
              sprite.setScale(baseScaleX, baseScaleY);
              sprite.setAlpha(index === 0 ? baseAlpha : 0);
              sprite.setFlipX(Boolean(placement.flipX));
              sprite.setDepth(depth + index * 0.01);
              this.developmentPngPropSprites.push(sprite);
              return sprite;
            }
          }

          const sprite = this.add.image(placement.x, placement.y, lookTextureKey);
          sprite.setName(`${placement.id}:${index}`);
          sprite.setOrigin(originX, originY);
          sprite.setScale(baseScaleX, baseScaleY);
          sprite.setAlpha(index === 0 ? baseAlpha : 0);
          sprite.setFlipX(Boolean(placement.flipX));
          sprite.setDepth(depth + index * 0.01);
          this.developmentPngPropSprites.push(sprite);
          return sprite;
        }

        private drawClubSkywalkDoorPng() {
          if (!this.hasClubSkywalkDoorPng()) return;
          const placement = getQortalLandDevelopmentClubDoorPlacement();
          const textureKeys = QORTAL_LAND_DEVELOPMENT_CLUB_DOOR_ASSET_IDS.map((assetId) =>
            qortalLandDevelopmentPngTextureKey(assetId)
          );
          const baseScaleX = placement.scaleX ?? placement.scale ?? 1;
          const baseScaleY = placement.scaleY ?? placement.scale ?? 1;
          const baseAlpha = placement.alpha ?? 1;
          const sprites = textureKeys.map((textureKey, index) =>
            this.createWarpableDevelopmentPng(placement, textureKey, index)
          );
          const hotspot = qortalLandClubSkywalkDoorHotspot(placement);
          this.clubSkywalkDoor = {
            closed: sprites[0],
            semiOpen: sprites[1],
            open: sprites[2],
            progress: 0,
            targetProgress: 0,
            baseAlpha,
            baseScaleX,
            baseScaleY,
            hotspotX: hotspot.x,
            hotspotY: hotspot.y,
            proximityRadius: hotspot.proximityRadius,
            passMinX: hotspot.passMinX,
            passMaxX: hotspot.passMaxX,
            passMinY: hotspot.passMinY,
            passMaxY: hotspot.passMaxY,
            returnX: hotspot.returnX,
            returnY: hotspot.returnY,
            left: hotspot.left,
            right: hotspot.right,
            top: hotspot.top,
            bottom: hotspot.bottom,
          };
        }

        private ensureCharacterAnimations() {
          if (!this.anims.exists(LAND_CHARACTER_IDLE_SIDE_ANIM_KEY)) {
            this.anims.create({
              key: LAND_CHARACTER_IDLE_SIDE_ANIM_KEY,
              frames: this.anims.generateFrameNumbers(LAND_CHARACTER_SPRITESHEET_KEY, { start: 0, end: 0 }),
              frameRate: 1,
              repeat: 0,
            });
          }
          if (!this.anims.exists(LAND_CHARACTER_WALK_SIDE_ANIM_KEY)) {
            this.anims.create({
              key: LAND_CHARACTER_WALK_SIDE_ANIM_KEY,
              frames: this.anims.generateFrameNumbers(LAND_CHARACTER_SPRITESHEET_KEY, {
                start: 0,
                end: LAND_CHARACTER_FRAMES_PER_DIRECTION - 1,
              }),
              frameRate: 10,
              repeat: -1,
            });
          }
          if (!this.anims.exists(LAND_CHARACTER_IDLE_DOWN_ANIM_KEY)) {
            this.anims.create({
              key: LAND_CHARACTER_IDLE_DOWN_ANIM_KEY,
              frames: this.anims.generateFrameNumbers(LAND_CHARACTER_SPRITESHEET_KEY, {
                start: LAND_CHARACTER_FRAMES_PER_DIRECTION,
                end: LAND_CHARACTER_FRAMES_PER_DIRECTION,
              }),
              frameRate: 1,
              repeat: 0,
            });
          }
          if (!this.anims.exists(LAND_CHARACTER_WALK_DOWN_ANIM_KEY)) {
            this.anims.create({
              key: LAND_CHARACTER_WALK_DOWN_ANIM_KEY,
              frames: this.anims.generateFrameNumbers(LAND_CHARACTER_SPRITESHEET_KEY, {
                start: LAND_CHARACTER_FRAMES_PER_DIRECTION,
                end: LAND_CHARACTER_FRAMES_PER_DIRECTION * 2 - 1,
              }),
              frameRate: 10,
              repeat: -1,
            });
          }
          if (!this.anims.exists(LAND_CHARACTER_IDLE_UP_ANIM_KEY)) {
            this.anims.create({
              key: LAND_CHARACTER_IDLE_UP_ANIM_KEY,
              frames: this.anims.generateFrameNumbers(LAND_CHARACTER_SPRITESHEET_KEY, {
                start: LAND_CHARACTER_FRAMES_PER_DIRECTION * 2,
                end: LAND_CHARACTER_FRAMES_PER_DIRECTION * 2,
              }),
              frameRate: 1,
              repeat: 0,
            });
          }
          if (!this.anims.exists(LAND_CHARACTER_WALK_UP_ANIM_KEY)) {
            this.anims.create({
              key: LAND_CHARACTER_WALK_UP_ANIM_KEY,
              frames: this.anims.generateFrameNumbers(LAND_CHARACTER_SPRITESHEET_KEY, {
                start: LAND_CHARACTER_FRAMES_PER_DIRECTION * 2,
                end: LAND_CHARACTER_FRAMES_PER_DIRECTION * 3 - 1,
              }),
              frameRate: 10,
              repeat: -1,
            });
          }
        }

        private createAvatar(x: number, y: number, _color: number, _local: boolean) {
          const avatar = this.add.sprite(x, y, LAND_CHARACTER_SPRITESHEET_KEY, LAND_CHARACTER_FRAMES_PER_DIRECTION);
          avatar.setOrigin(0.5, LAND_CHARACTER_FEET_BASELINE / LAND_CHARACTER_FRAME_SIZE);
          avatar.setSize(104, 174);
          avatar.play(LAND_CHARACTER_IDLE_DOWN_ANIM_KEY);
          avatar.setData('lastAnimation', LAND_CHARACTER_IDLE_DOWN_ANIM_KEY);
          avatar.setData('logicalX', x);
          avatar.setData('logicalY', y);
          return avatar;
        }

        private animateAvatar(avatar: any, moving: boolean, direction: string) {
          const animationKey = avatarAnimationKeyForDirection(direction, moving);
          if (avatar?.getData?.('lastAnimation') === animationKey) return;
          avatar?.play?.(animationKey, true);
          avatar?.setData?.('lastAnimation', animationKey);
        }

        private updateClubSkywalkDoor(delta: number) {
          const door = this.clubSkywalkDoor;
          if (!door) return;
          const avatar = this.localAvatar;
          const isInClub = currentRoomRef.current === QORTAL_LAND_DEFAULT_ROOM_ID;
          const avatarLogicalX = Number(avatar?.getData?.('logicalX'));
          const avatarLogicalY = Number(avatar?.getData?.('logicalY'));
          const weightedDistance = avatar && isInClub
            ? Math.hypot(
                (Number.isFinite(avatarLogicalX) ? avatarLogicalX : avatar.x) - door.hotspotX,
                ((Number.isFinite(avatarLogicalY) ? avatarLogicalY : avatar.y) - door.hotspotY) * 1.16
              )
            : Number.POSITIVE_INFINITY;
          door.targetProgress = weightedDistance <= door.proximityRadius ? 1 : 0;
          const speed = door.targetProgress > door.progress
            ? QORTAL_LAND_CLUB_SKYWALK_DOOR_OPEN_SPEED
            : QORTAL_LAND_CLUB_SKYWALK_DOOR_CLOSE_SPEED;
          const step = Math.max(0.001, delta * speed);
          if (door.targetProgress > door.progress) {
            door.progress = Math.min(door.targetProgress, door.progress + step);
          } else {
            door.progress = Math.max(door.targetProgress, door.progress - step);
          }

          const progress = Phaser.Math.Easing.Sine.InOut(door.progress);
          const closedAlpha = door.baseAlpha * (1 - Phaser.Math.Clamp(progress / 0.52, 0, 1));
          const semiOpenAlpha = door.baseAlpha * Math.max(0, 1 - Math.abs(progress - 0.5) / 0.5);
          const openAlpha = door.baseAlpha * Phaser.Math.Clamp((progress - 0.36) / 0.64, 0, 1);
          door.closed.setAlpha(closedAlpha);
          door.semiOpen.setAlpha(semiOpenAlpha);
          door.open.setAlpha(openAlpha);
          door.closed.setScale(door.baseScaleX * (1 - progress * 0.025), door.baseScaleY);
          door.semiOpen.setScale(
            door.baseScaleX * (0.98 + Math.sin(progress * Math.PI) * 0.045),
            door.baseScaleY
          );
          door.open.setScale(door.baseScaleX * (0.985 + progress * 0.028), door.baseScaleY);
        }

        private createPropLayer(depth: number) {
          const layer = this.add.graphics();
          layer.setDepth(depth);
          this.propLayers.push(layer);
          return layer;
        }

        private drawDevelopmentPngProps() {
          if (!shouldShowQortalLandDevelopmentPngProps()) return;
          const roomId = currentRoomRef.current;
          for (const basePlacement of QORTAL_LAND_DEVELOPMENT_PNG_PROP_PLACEMENTS) {
            const placement = {
              ...basePlacement,
              ...readQortalLandDevelopmentPngPlacementOverride(basePlacement.id),
            };
            if (placement.visible === false) continue;
            if (placement.roomIds && !placement.roomIds.includes(roomId)) continue;
            const asset = qortalLandDevelopmentPngAssetById.get(placement.assetId);
            if (!asset) {
              if (!warnedMissingDevelopmentPngAssets.has(placement.assetId)) {
                warnedMissingDevelopmentPngAssets.add(placement.assetId);
                console.warn(
                  `[QortalLand] Development PNG asset not found: ${placement.assetId}`
                );
              }
              continue;
            }
            const textureKey = qortalLandDevelopmentPngTextureKey(asset.id);
            if (!this.textures.exists(textureKey)) continue;
            const instanceCount = Math.max(1, Math.min(12, Math.round(placement.count ?? 1)));
            const spacing = placement.spacing ?? 0;
            const startOffsetX = -((instanceCount - 1) * spacing) / 2;
            for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
              const instanceX = placement.x + startOffsetX + instanceIndex * spacing;
              const instanceY = placement.y;
              if (placement.contactShadow) {
                const shadow = placement.contactShadow;
                const shadowGraphic = this.add.graphics();
                shadowGraphic.setName(
                  instanceCount === 1
                    ? `${placement.id}:contact-shadow`
                    : `${placement.id}:${instanceIndex}:contact-shadow`
                );
                shadowGraphic.fillStyle(shadow.color ?? 0x000000, shadow.alpha ?? 0.2);
                shadowGraphic.fillEllipse(
                  instanceX + (shadow.offsetX ?? 0),
                  instanceY + (shadow.offsetY ?? 0),
                  shadow.width,
                  shadow.height
                );
                shadowGraphic.setDepth(
                  shadow.depth ??
                    (placement.depthMode === 'y-sort'
                      ? instanceY + (placement.depthOffset ?? 20) - 1
                      : (placement.depth ?? instanceY) + (shadow.depthOffset ?? -1))
                );
                this.developmentPngPropSprites.push(shadowGraphic);
              }
              const instancePlacement = {
                ...placement,
                x: instanceX,
                y: instanceY,
                depth:
                  placement.depthMode === 'y-sort'
                    ? instanceY + (placement.depthOffset ?? 20)
                    : placement.depth ?? instanceY,
              };
              if (this.hasWarpOffset(instancePlacement.warp)) {
                this.createWarpableDevelopmentPng(
                  instancePlacement,
                  textureKey,
                  instanceIndex
                );
                continue;
              }
              const lookTextureKey = this.developmentLookTextureKeyForPlacement(
                instancePlacement,
                textureKey
              );
              const sprite = this.add.image(instanceX, instanceY, lookTextureKey);
              sprite.setName(
                instanceCount === 1 ? placement.id : `${placement.id}:${instanceIndex}`
              );
              sprite.setOrigin(placement.originX ?? 0.5, placement.originY ?? 1);
              sprite.setScale(
                placement.scaleX ?? placement.scale ?? 1,
                placement.scaleY ?? placement.scale ?? 1
              );
              sprite.setAlpha(placement.alpha ?? 1);
              sprite.setFlipX(Boolean(placement.flipX));
              sprite.setDepth(instancePlacement.depth);
              this.developmentPngPropSprites.push(sprite);
            }
          }
        }

        private drawCollisionDebug() {
          if (!shouldShowQortalLandCollisionDebug()) return;
          const roomId = currentRoomRef.current;
          for (const footprint of qortalLandCollisionFootprintsForRoom(roomId)) {
            const expanded = qortalLandExpandedCollisionRadii(footprint);
            const debugGraphic = this.add.graphics();
            debugGraphic.setName(`collision-debug:${footprint.x}:${footprint.y}`);
            debugGraphic.setDepth(9997);
            debugGraphic.lineStyle(2, 0xffe066, 0.9);
            debugGraphic.fillStyle(0xffe066, 0.14);
            if (footprint.shape === 'rect') {
              debugGraphic.fillRect(
                footprint.x - expanded.x,
                footprint.y - expanded.y,
                expanded.x * 2,
                expanded.y * 2
              );
              debugGraphic.strokeRect(
                footprint.x - expanded.x,
                footprint.y - expanded.y,
                expanded.x * 2,
                expanded.y * 2
              );
            } else {
              debugGraphic.fillEllipse(footprint.x, footprint.y, expanded.x * 2, expanded.y * 2);
              debugGraphic.strokeEllipse(footprint.x, footprint.y, expanded.x * 2, expanded.y * 2);
            }
            this.developmentPngPropSprites.push(debugGraphic);
          }
        }

        private createInteractionPrompt() {
          const hotspot = roomLayoutForRoom(QORTAL_LAND_DEFAULT_ROOM_ID).interactions?.djBooth;
          const background = this.add.graphics();
          const text = this.add.text(0, 0, '[E] Interact', {
            color: '#f8fbff',
            fontFamily: 'Inter, Arial, sans-serif',
            fontSize: '13px',
            fontStyle: '700',
            stroke: '#050711',
            strokeThickness: 4,
          });
          const container = this.add.container(hotspot?.x ?? 0, hotspot?.promptY ?? 0, [background, text]);
          container.setDepth(9998);
          container.setVisible(false);
          text.setOrigin(0.5);
          background.fillStyle(0x050711, 0.86);
          background.fillRoundedRect(-58, -19, 116, 34, 11);
          background.lineStyle(2, 0x2cf8ff, 0.58);
          background.strokeRoundedRect(-58, -19, 116, 34, 11);
          background.fillStyle(0xff2bd6, 0.14);
          background.fillRoundedRect(-52, 9, 104, 4, 2);
          return { container, background, text };
        }

        private updateInteractionPrompt() {
          if (!this.interactionPrompt || !this.localAvatar) return;
          const avatarLogicalX = Number(this.localAvatar.getData('logicalX'));
          const avatarLogicalY = Number(this.localAvatar.getData('logicalY'));
          const show = isNearClubDjBooth(
            currentRoomRef.current,
            Number.isFinite(avatarLogicalX) ? avatarLogicalX : this.localAvatar.x,
            Number.isFinite(avatarLogicalY) ? avatarLogicalY : this.localAvatar.y
          );
          this.interactionPrompt.container.setVisible(show);
          if (!show) return;
          const pulse = 0.88 + Math.sin(this.time.now / 180) * 0.12;
          const hotspot = roomLayoutForRoom(QORTAL_LAND_DEFAULT_ROOM_ID).interactions?.djBooth;
          this.interactionPrompt.container.setPosition(
            hotspot?.x ?? this.interactionPrompt.container.x,
            (hotspot?.promptY ?? this.interactionPrompt.container.y) - pulse * 3
          );
          this.interactionPrompt.container.setAlpha(0.88 + pulse * 0.12);
        }

        private drawNeonText(g: any, x: number, y: number) {
          g.fillStyle(0xff2bd6, 1);
          g.fillRoundedRect(x, y, 16, 8, 4);
          g.fillRoundedRect(x, y + 8, 8, 16, 4);
          g.fillRoundedRect(x + 18, y, 8, 24, 4);
          g.fillRoundedRect(x + 32, y, 8, 24, 4);
          g.fillRoundedRect(x + 32, y + 16, 16, 8, 4);
          g.fillStyle(0x2cf8ff, 1);
          g.fillRoundedRect(x + 62, y, 10, 24, 5);
          g.fillRoundedRect(x + 80, y, 10, 24, 5);
          g.fillRoundedRect(x + 98, y, 10, 24, 5);
          g.fillRoundedRect(x + 116, y, 10, 24, 5);
          g.fillStyle(0xffae00, 1);
          g.fillRoundedRect(x + 146, y, 14, 24, 4);
          g.fillRoundedRect(x + 164, y, 14, 24, 4);
        }

        private drawFloorTexture(g: any) {
          const floor = roomLayoutForRoom(QORTAL_LAND_DEFAULT_ROOM_ID).floor;
          g.fillStyle(0x101830, 0.26);
          g.fillPoints([
            new Phaser.Geom.Point(floor.back.minX + 33, floor.topY + 18),
            new Phaser.Geom.Point(floor.back.maxX - 33, floor.topY + 18),
            new Phaser.Geom.Point(floor.front.maxX - 41, floor.bottomY - 18),
            new Phaser.Geom.Point(floor.front.minX + 41, floor.bottomY - 18),
          ], true);
          for (let i = 0; i < 14; i += 1) {
            const y = floor.topY + 26 + (i % 13) * 28;
            const bounds = floorBoundsForY(y);
            const availableWidth = Math.max(1, bounds.maxX - bounds.minX - 120);
            const x = bounds.minX + 34 + ((i * 73) % availableWidth);
            const width = 56 + (i % 5) * 22;
            g.fillStyle(i % 2 === 0 ? 0x2cf8ff : 0xff2bd6, 0.018);
            g.fillRoundedRect(x, y, width, 5, 3);
          }
          for (let i = 0; i < 5; i += 1) {
            const y = 366 + i * 18;
            const bounds = floorBoundsForY(y);
            g.lineStyle(1, 0xffffff, 0.018);
            g.lineBetween(bounds.minX + 24, y, bounds.maxX - 24, y + 2);
          }
          g.fillStyle(0x2cf8ff, 0.022);
          g.fillEllipse(705, 520, 420, 72);
          g.fillStyle(0xff2bd6, 0.018);
          g.fillEllipse(1125, 580, 520, 92);
          g.fillStyle(0x000000, 0.18);
          g.fillEllipse(900, floor.bottomY + 10, 1530, 56);
        }

        private drawSideWalls(g: any) {
          const layout = roomLayoutForRoom(QORTAL_LAND_DEFAULT_ROOM_ID);
          const { floor } = layout;
          g.fillStyle(0x080b19, 0.92);
          g.fillPoints([
            new Phaser.Geom.Point(0, 128),
            new Phaser.Geom.Point(floor.back.minX, floor.topY),
            new Phaser.Geom.Point(floor.front.minX, floor.bottomY),
            new Phaser.Geom.Point(0, floor.bottomY + 40),
          ], true);
          g.fillStyle(0x0b1022, 0.92);
          g.fillPoints([
            new Phaser.Geom.Point(layout.width, 128),
            new Phaser.Geom.Point(floor.back.maxX, floor.topY),
            new Phaser.Geom.Point(floor.front.maxX, floor.bottomY),
            new Phaser.Geom.Point(layout.width, floor.bottomY + 40),
          ], true);
          g.lineStyle(2, 0x2cf8ff, 0.055);
          for (let y = 220; y <= 560; y += 170) {
            g.lineBetween(18, y, 155, y + 72);
            g.lineBetween(layout.width - 18, y, layout.width - 155, y + 72);
          }
          g.lineStyle(3, 0xff2bd6, 0.11);
          g.lineBetween(0, 128, floor.back.minX, floor.topY);
          g.lineStyle(3, 0x2cf8ff, 0.11);
          g.lineBetween(layout.width, 128, floor.back.maxX, floor.topY);
        }

        private drawClubBackWall(g: any) {
          const floor = roomLayoutForRoom(QORTAL_LAND_DEFAULT_ROOM_ID).floor;
          g.fillStyle(0x060917, 0.56);
          g.fillRoundedRect(188, 166, 1424, 218, 22);
          g.fillStyle(0x0d1328, 0.92);
          g.fillPoints([
            new Phaser.Geom.Point(floor.back.minX, floor.topY),
            new Phaser.Geom.Point(floor.back.maxX, floor.topY),
            new Phaser.Geom.Point(1484, 392),
            new Phaser.Geom.Point(316, 392),
          ], true);
          g.lineStyle(2, 0x2cf8ff, 0.1);
          g.lineBetween(230, 327, 1570, 327);
          g.lineBetween(250, 366, 1550, 366);

          for (let i = 0; i < 7; i += 1) {
            const x = 268 + i * 196;
            const panelColor = i % 2 === 0 ? 0x071021 : 0x0a1024;
            g.fillStyle(panelColor, 0.62);
            g.fillPoints([
              new Phaser.Geom.Point(x, 300),
              new Phaser.Geom.Point(x + 154, 300),
              new Phaser.Geom.Point(x + 132, 390),
              new Phaser.Geom.Point(x + 18, 390),
            ], true);
            g.lineStyle(1, i % 2 === 0 ? 0x2cf8ff : 0xff2bd6, 0.09);
            g.strokePoints([
              new Phaser.Geom.Point(x, 300),
              new Phaser.Geom.Point(x + 154, 300),
              new Phaser.Geom.Point(x + 132, 390),
              new Phaser.Geom.Point(x + 18, 390),
              new Phaser.Geom.Point(x, 300),
            ], false);
          }

          g.fillStyle(0x02040b, 0.34);
          g.fillEllipse(900, 404, 1010, 72);
          g.fillStyle(0x2cf8ff, 0.032);
          g.fillTriangle(675, 88, 748, floor.topY, 796, floor.topY);
          g.fillStyle(0xff2bd6, 0.032);
          g.fillTriangle(1125, 88, 1004, floor.topY, 1052, floor.topY);
        }

        private drawCeilingRig(g: any) {
          g.lineStyle(9, 0x03040a, 0.9);
          g.lineBetween(360, 78, 1440, 78);
          g.lineStyle(3, 0x151b35, 0.88);
          g.lineBetween(360, 78, 1440, 78);
          g.lineStyle(2, 0x2cf8ff, 0.16);
          g.lineBetween(360, 78, 760, 165);
          g.lineBetween(1440, 78, 1040, 165);
          g.lineStyle(1, 0xff2bd6, 0.1);
          g.lineBetween(250, 76, 760, 165);
          g.lineBetween(1550, 76, 1040, 165);
          for (let x = 460; x <= 1340; x += 176) {
            g.fillStyle(0x02030a, 0.72);
            g.fillEllipse(x, 82, 46, 18);
            g.fillStyle(0x090b18, 1);
            g.fillCircle(x, 78, 18);
            g.fillStyle(0x0f1730, 1);
            g.fillCircle(x, 78, 12);
            g.lineStyle(2, x % 352 === 0 ? 0xff2bd6 : 0x2cf8ff, 0.42);
            g.strokeCircle(x, 78, 14);
            g.fillStyle(x % 352 === 0 ? 0xff2bd6 : 0x2cf8ff, 0.16);
            g.fillCircle(x, 78, 7);
          }
          g.fillStyle(0x02030a, 0.45);
          g.fillEllipse(900, 111, 124, 24);
          g.fillStyle(0xc7f8ff, 0.62);
          g.fillCircle(900, 86, 28);
          g.fillStyle(0x2cf8ff, 0.14);
          g.fillCircle(900, 86, 46);
          g.lineStyle(2, 0xf8fbff, 0.22);
          g.strokeCircle(900, 86, 28);
          g.lineStyle(1, 0x10152a, 0.5);
          for (let offset = -20; offset <= 20; offset += 10) {
            g.lineBetween(900 + offset, 61, 900 - offset, 111);
            g.lineBetween(875, 86 + offset, 925, 86 - offset);
          }
          for (let ray = 0; ray < 16; ray += 1) {
            const angle = (Math.PI * 2 * ray) / 16;
            const innerX = 900 + Math.cos(angle) * 6;
            const innerY = 86 + Math.sin(angle) * 6;
            const outerX = 900 + Math.cos(angle) * 28;
            const outerY = 86 + Math.sin(angle) * 28;
            g.lineStyle(1, ray % 2 === 0 ? 0xf8fbff : 0x2cf8ff, 0.18);
            g.lineBetween(innerX, innerY, outerX, outerY);
          }
        }

        private drawSkywalkDoor(g: any, x: number, y: number) {
          g.fillStyle(0x070914, 0.96);
          g.fillRoundedRect(x - 34, y - 20, 204, 238, 16);
          g.lineStyle(2, 0x2cf8ff, 0.12);
          g.strokeRoundedRect(x - 34, y - 20, 204, 238, 16);
          g.fillStyle(0x2cf8ff, 0.055);
          g.fillRoundedRect(x - 18, y - 4, 172, 208, 20);
          g.fillStyle(0xff2bd6, 0.04);
          g.fillRoundedRect(x - 5, y + 8, 146, 184, 18);
          g.fillStyle(0x050713, 0.98);
          g.fillRoundedRect(x, y, 136, 188, 16);
          g.fillStyle(0x091225, 1);
          g.fillRoundedRect(x + 14, y + 16, 108, 156, 12);
          g.fillStyle(0x02030a, 1);
          g.fillRoundedRect(x + 31, y + 34, 74, 120, 10);
          g.fillStyle(0x101b3a, 0.92);
          g.fillRoundedRect(x + 38, y + 42, 60, 104, 8);
          for (let i = 0; i < 6; i += 1) {
            const alpha = 0.18 + i * 0.055;
            g.lineStyle(2, i % 2 === 0 ? 0x2cf8ff : 0xff2bd6, alpha);
            g.lineBetween(x + 46 + i * 4, y + 50, x + 84 - i * 2, y + 140);
          }
          for (let i = 0; i < 7; i += 1) {
            g.fillStyle(i % 2 === 0 ? 0x2cf8ff : 0xff2bd6, 0.42);
            g.fillCircle(x + 52 + (i % 3) * 14, y + 55 + i * 13, 2.5);
          }
          g.lineStyle(5, 0x2cf8ff, 0.78);
          g.strokeRoundedRect(x + 14, y + 16, 108, 156, 12);
          g.lineStyle(3, 0xff2bd6, 0.5);
          g.strokeRoundedRect(x + 26, y + 28, 84, 132, 10);
          for (let i = 0; i < 4; i += 1) {
            g.lineStyle(2, 0x2cf8ff, 0.28 - i * 0.04);
            g.strokeRoundedRect(x + 5 - i * 7, y + 5 - i * 7, 126 + i * 14, 178 + i * 14, 16);
          }
          g.fillStyle(0xf8fbff, 0.74);
          g.fillCircle(x + 104, y + 100, 5);
          g.fillStyle(0x2cf8ff, 0.3);
          g.fillRoundedRect(x + 18, y + 188, 100, 12, 6);
          g.fillStyle(0xff2bd6, 0.24);
          g.fillRoundedRect(x + 34, y + 204, 68, 8, 4);
          g.fillStyle(0xffae00, 0.5);
          g.fillTriangle(x + 68, y + 183, x + 58, y + 170, x + 78, y + 170);
        }

        private drawParkPortal(g: any, x: number, y: number, flip = false) {
          const accent = 0x78ff9a;
          const secondary = 0x2cf8ff;
          g.fillStyle(0x02050a, 0.86);
          g.fillEllipse(x + 72, y + 196, 168, 34);
          for (let i = 0; i < 4; i += 1) {
            g.lineStyle(3, i % 2 === 0 ? accent : secondary, 0.2 - i * 0.028);
            g.strokeRoundedRect(x - i * 9, y - i * 7, 144 + i * 18, 202 + i * 14, 34);
          }
          g.fillStyle(0x061018, 0.98);
          g.fillRoundedRect(x + 8, y + 8, 128, 184, 28);
          g.fillStyle(0x10242a, 0.94);
          g.fillRoundedRect(x + 21, y + 22, 102, 158, 24);
          g.fillStyle(0x78ff9a, 0.12);
          g.fillRoundedRect(x + 32, y + 34, 80, 136, 22);
          for (let i = 0; i < 5; i += 1) {
            const offset = flip ? -i * 7 : i * 7;
            g.lineStyle(2, i % 2 === 0 ? accent : secondary, 0.28 + i * 0.04);
            g.lineBetween(x + 44 + offset, y + 48, x + 96 - offset * 0.4, y + 158);
          }
          g.lineStyle(5, accent, 0.72);
          g.strokeRoundedRect(x + 18, y + 18, 108, 164, 26);
          g.lineStyle(2, secondary, 0.5);
          g.strokeRoundedRect(x + 32, y + 34, 80, 132, 22);
          g.fillStyle(0xf8fbff, 0.8);
          g.fillCircle(x + (flip ? 42 : 103), y + 104, 4);
          g.fillStyle(accent, 0.32);
          g.fillRoundedRect(x + 24, y + 188, 96, 10, 5);
          g.fillStyle(secondary, 0.22);
          g.fillRoundedRect(x + 42, y + 202, 60, 7, 4);
        }

        private drawSkylineWindow(g: any, x: number, y: number, width: number, height: number) {
          g.fillStyle(0x050817, 1);
          g.fillRoundedRect(x, y, width, height, 18);
          g.fillStyle(0x07142c, 1);
          g.fillRoundedRect(x + 12, y + 12, width - 24, height - 24, 14);
          g.lineStyle(4, 0x2cf8ff, 0.32);
          g.strokeRoundedRect(x, y, width, height, 18);
          g.lineStyle(2, 0xff2bd6, 0.18);
          g.lineBetween(x + 40, y + height - 38, x + width - 40, y + height - 38);
          g.fillStyle(0xff2bd6, 0.14);
          g.fillCircle(x + width * 0.68, y + 74, 42);
          g.fillStyle(0x2cf8ff, 0.08);
          g.fillCircle(x + width * 0.25, y + 92, 62);
          for (let tower = 0; tower < 17; tower += 1) {
            const towerX = x + 54 + tower * ((width - 120) / 16);
            const towerW = 34 + (tower % 4) * 9;
            const towerH = 62 + (tower % 5) * 28;
            const baseY = y + height - 42;
            g.fillStyle(tower % 2 === 0 ? 0x070a18 : 0x0b1024, 0.96);
            g.fillRect(towerX, baseY - towerH, towerW, towerH);
            for (let row = 0; row < Math.floor(towerH / 18); row += 1) {
              for (let col = 0; col < Math.max(1, Math.floor(towerW / 13)); col += 1) {
                const lit = (tower + row + col) % 3 !== 0;
                g.fillStyle(lit ? 0x2cf8ff : 0x17213c, lit ? 0.52 : 0.32);
                g.fillRoundedRect(towerX + 6 + col * 13, baseY - towerH + 10 + row * 17, 7, 6, 2);
              }
            }
          }
          g.fillStyle(0x000000, 0.2);
          g.fillRect(x + 18, y + height - 54, width - 36, 32);
        }

        private drawSkywalkWorld(g: any) {
          const range = roomFloorRange(QORTAL_LAND_SKYWALK_ROOM_ID);
          g.fillStyle(0x050714, 1);
          g.fillRect(0, 0, LAND_WIDTH, LAND_HEIGHT);
          g.fillStyle(0x0c1226, 1);
          g.fillRect(0, 0, LAND_WIDTH, range.top);
          this.drawSkylineWindow(g, 64, 42, LAND_WIDTH - 128, 238);
          g.fillStyle(0x050711, 1);
          g.fillPoints([
            new Phaser.Geom.Point(128, range.top),
            new Phaser.Geom.Point(1672, range.top),
            new Phaser.Geom.Point(1650, range.bottom),
            new Phaser.Geom.Point(150, range.bottom),
          ], true);
          g.fillStyle(0x10172d, 0.86);
          g.fillPoints([
            new Phaser.Geom.Point(150, range.top + 26),
            new Phaser.Geom.Point(1650, range.top + 26),
            new Phaser.Geom.Point(1605, range.bottom - 18),
            new Phaser.Geom.Point(195, range.bottom - 18),
          ], true);
          g.lineStyle(3, 0x2cf8ff, 0.22);
          g.strokePoints([
            new Phaser.Geom.Point(128, range.top),
            new Phaser.Geom.Point(1672, range.top),
            new Phaser.Geom.Point(1650, range.bottom),
            new Phaser.Geom.Point(150, range.bottom),
            new Phaser.Geom.Point(128, range.top),
          ], false);
          for (let i = 0; i < 6; i += 1) {
            const y = range.top + 56 + i * 44;
            const bounds = floorBoundsForRoomY(QORTAL_LAND_SKYWALK_ROOM_ID, y);
            g.lineStyle(1, 0xffffff, 0.035);
            g.lineBetween(bounds.minX + 50, y, bounds.maxX - 50, y);
          }
          g.fillStyle(0x050711, 1);
          g.fillRoundedRect(132, 292, 150, 118, 14);
          g.lineStyle(3, 0xff2bd6, 0.4);
          g.strokeRoundedRect(132, 292, 150, 118, 14);
          g.fillStyle(0x2cf8ff, 0.1);
          g.fillRoundedRect(154, 316, 106, 52, 10);
          g.fillStyle(0xf8fbff, 0.8);
          g.fillCircle(244, 352, 4);
          this.drawParkPortal(g, 1518, 250, true);
          this.drawEscalator(g, LAND_WIDTH / 2, 560, false);
          g.fillStyle(0xffae00, 0.08);
          g.fillEllipse(LAND_WIDTH / 2, 586, 360, 82);
        }

        private drawMallWorld(g: any) {
          const range = roomFloorRange(QORTAL_LAND_MALL_ROOM_ID);
          g.fillStyle(0x060811, 1);
          g.fillRect(0, 0, LAND_WIDTH, LAND_HEIGHT);
          g.fillStyle(0x10182a, 1);
          g.fillRect(0, 0, LAND_WIDTH, range.top);
          g.fillStyle(0x050711, 1);
          g.fillPoints([
            new Phaser.Geom.Point(150, range.top),
            new Phaser.Geom.Point(1650, range.top),
            new Phaser.Geom.Point(1730, range.bottom),
            new Phaser.Geom.Point(70, range.bottom),
          ], true);
          g.fillStyle(0x0d1222, 1);
          g.fillPoints([
            new Phaser.Geom.Point(190, range.top + 42),
            new Phaser.Geom.Point(1610, range.top + 42),
            new Phaser.Geom.Point(1665, range.bottom - 12),
            new Phaser.Geom.Point(135, range.bottom - 12),
          ], true);
          g.lineStyle(3, 0x2cf8ff, 0.16);
          g.strokePoints([
            new Phaser.Geom.Point(150, range.top),
            new Phaser.Geom.Point(1650, range.top),
            new Phaser.Geom.Point(1730, range.bottom),
            new Phaser.Geom.Point(70, range.bottom),
            new Phaser.Geom.Point(150, range.top),
          ], false);
          for (let row = 0; row < 5; row += 1) {
            const y = range.top + 74 + row * 58;
            const bounds = floorBoundsForRoomY(QORTAL_LAND_MALL_ROOM_ID, y);
            g.lineStyle(1, 0xffffff, 0.035);
            g.lineBetween(bounds.minX + 60, y, bounds.maxX - 60, y + 2);
          }
          this.drawEscalator(g, LAND_WIDTH / 2, 360, true);
          this.drawCinemaStorefront(g, 480, 132, 840, 210);
          g.fillStyle(0x2cf8ff, 0.05);
          g.fillEllipse(900, 585, 840, 120);
        }

        private drawParkWorld(g: any) {
          const range = roomFloorRange(QORTAL_LAND_PARK_ROOM_ID);
          g.fillStyle(0x030711, 1);
          g.fillRect(0, 0, LAND_WIDTH, LAND_HEIGHT);
          g.fillStyle(0x071329, 1);
          g.fillRect(0, 0, LAND_WIDTH, range.top + 18);

          g.fillStyle(0x14224a, 0.62);
          g.fillCircle(1390, 92, 58);
          g.fillStyle(0x78ff9a, 0.08);
          g.fillCircle(1390, 92, 86);
          g.fillStyle(0xff2bd6, 0.08);
          g.fillCircle(430, 154, 72);

          for (let i = 0; i < 18; i += 1) {
            const towerX = 70 + i * 96;
            const towerW = 44 + (i % 4) * 14;
            const towerH = 64 + (i % 6) * 22;
            const baseY = range.top + 12;
            g.fillStyle(i % 2 === 0 ? 0x070d1d : 0x091225, 0.92);
            g.fillRect(towerX, baseY - towerH, towerW, towerH);
            for (let row = 0; row < Math.floor(towerH / 22); row += 1) {
              for (let col = 0; col < Math.max(1, Math.floor(towerW / 18)); col += 1) {
                const lit = (i + row + col) % 4 !== 0;
                g.fillStyle(lit ? 0x2cf8ff : 0x17213c, lit ? 0.38 : 0.22);
                g.fillRoundedRect(towerX + 10 + col * 17, baseY - towerH + 14 + row * 20, 8, 7, 2);
              }
            }
          }

          g.fillStyle(0x07180f, 1);
          g.fillPoints([
            new Phaser.Geom.Point(110, range.top),
            new Phaser.Geom.Point(1690, range.top),
            new Phaser.Geom.Point(1776, range.bottom),
            new Phaser.Geom.Point(24, range.bottom),
          ], true);
          g.fillStyle(0x102a18, 0.95);
          g.fillPoints([
            new Phaser.Geom.Point(150, range.top + 38),
            new Phaser.Geom.Point(1650, range.top + 38),
            new Phaser.Geom.Point(1714, range.bottom - 10),
            new Phaser.Geom.Point(86, range.bottom - 10),
          ], true);

          g.fillStyle(0x06110d, 0.95);
          g.fillPoints([
            new Phaser.Geom.Point(520, range.top + 34),
            new Phaser.Geom.Point(710, range.top + 34),
            new Phaser.Geom.Point(1080, range.bottom - 14),
            new Phaser.Geom.Point(830, range.bottom - 14),
          ], true);
          g.fillStyle(0x203723, 0.85);
          g.fillPoints([
            new Phaser.Geom.Point(552, range.top + 50),
            new Phaser.Geom.Point(688, range.top + 50),
            new Phaser.Geom.Point(1028, range.bottom - 26),
            new Phaser.Geom.Point(868, range.bottom - 26),
          ], true);

          g.lineStyle(4, 0x78ff9a, 0.18);
          g.strokePoints([
            new Phaser.Geom.Point(110, range.top),
            new Phaser.Geom.Point(1690, range.top),
            new Phaser.Geom.Point(1776, range.bottom),
            new Phaser.Geom.Point(24, range.bottom),
            new Phaser.Geom.Point(110, range.top),
          ], false);

          g.fillStyle(0x2cf8ff, 0.12);
          g.fillEllipse(1220, 560, 340, 110);
          g.fillStyle(0x071922, 0.96);
          g.fillEllipse(1220, 560, 290, 82);
          g.lineStyle(3, 0x2cf8ff, 0.34);
          g.strokeEllipse(1220, 560, 290, 82);
          g.fillStyle(0xf8fbff, 0.24);
          g.fillEllipse(1174, 540, 72, 12);
          g.fillStyle(0x78ff9a, 0.16);
          g.fillCircle(1220, 536, 34);

          this.drawParkPortal(g, 126, 250);
          this.drawParkTree(g, 310, 386, 0x78ff9a);
          this.drawParkTree(g, 1510, 388, 0x2cf8ff);
          this.drawParkTree(g, 420, 596, 0x78ff9a);
          this.drawParkTree(g, 1470, 616, 0xff2bd6);
          this.drawParkBench(g, 600, 482, 0x2cf8ff);
          this.drawParkBench(g, 1330, 462, 0xffae00);
          this.drawParkBench(g, 720, 642, 0x78ff9a);
        }

        private drawParkTree(g: any, x: number, y: number, color: number) {
          g.fillStyle(0x02040a, 0.35);
          g.fillEllipse(x, y + 62, 128, 28);
          g.fillStyle(0x1b1020, 1);
          g.fillRoundedRect(x - 13, y + 8, 26, 86, 10);
          g.fillStyle(color, 0.16);
          g.fillCircle(x, y, 64);
          g.fillStyle(color, 0.22);
          g.fillCircle(x - 34, y + 20, 42);
          g.fillCircle(x + 34, y + 20, 42);
          g.fillStyle(0x07180f, 0.96);
          g.fillCircle(x, y + 10, 46);
          g.lineStyle(2, color, 0.42);
          g.strokeCircle(x, y + 10, 46);
          g.fillStyle(color, 0.48);
          g.fillCircle(x + 30, y - 10, 5);
          g.fillCircle(x - 24, y + 22, 4);
        }

        private drawParkBench(g: any, x: number, y: number, color: number) {
          g.fillStyle(0x02040a, 0.32);
          g.fillEllipse(x + 82, y + 52, 190, 24);
          g.fillStyle(0x070914, 0.98);
          g.fillRoundedRect(x, y, 164, 32, 10);
          g.fillStyle(0x11182b, 1);
          g.fillRoundedRect(x + 12, y + 8, 140, 14, 7);
          g.lineStyle(3, color, 0.42);
          g.strokeRoundedRect(x, y, 164, 32, 10);
          g.fillStyle(color, 0.28);
          g.fillRoundedRect(x + 22, y + 36, 120, 12, 6);
          g.fillStyle(0x050711, 1);
          g.fillRoundedRect(x + 28, y + 26, 14, 38, 5);
          g.fillRoundedRect(x + 122, y + 26, 14, 38, 5);
        }

        private drawEscalator(g: any, centerX: number, centerY: number, up: boolean) {
          const topY = centerY - 92;
          const bottomY = centerY + 112;
          const topHalf = up ? 120 : 92;
          const bottomHalf = up ? 72 : 150;
          g.fillStyle(0x02040b, 0.62);
          g.fillEllipse(centerX, bottomY + 30, 360, 48);
          g.fillStyle(0x070a17, 0.98);
          g.fillPoints([
            new Phaser.Geom.Point(centerX - topHalf, topY),
            new Phaser.Geom.Point(centerX + topHalf, topY),
            new Phaser.Geom.Point(centerX + bottomHalf, bottomY),
            new Phaser.Geom.Point(centerX - bottomHalf, bottomY),
          ], true);
          g.fillStyle(0x121a30, 1);
          g.fillPoints([
            new Phaser.Geom.Point(centerX - topHalf + 28, topY + 18),
            new Phaser.Geom.Point(centerX + topHalf - 28, topY + 18),
            new Phaser.Geom.Point(centerX + bottomHalf - 26, bottomY - 18),
            new Phaser.Geom.Point(centerX - bottomHalf + 26, bottomY - 18),
          ], true);
          g.lineStyle(5, 0x2cf8ff, 0.34);
          g.lineBetween(centerX - topHalf, topY, centerX - bottomHalf, bottomY);
          g.lineBetween(centerX + topHalf, topY, centerX + bottomHalf, bottomY);
          for (let i = 0; i < 7; i += 1) {
            const t = i / 6;
            const y = topY + 32 + t * (bottomY - topY - 64);
            const half = topHalf + (bottomHalf - topHalf) * t - 38;
            g.lineStyle(2, 0xffffff, 0.08);
            g.lineBetween(centerX - half, y, centerX + half, y);
          }
          g.fillStyle(0xffae00, 0.18);
          g.fillRoundedRect(centerX - 92, topY - 34, 184, 24, 10);
          g.lineStyle(2, 0xffae00, 0.42);
          g.strokeRoundedRect(centerX - 92, topY - 34, 184, 24, 10);
        }

        private drawCinemaStorefront(g: any, x: number, y: number, width: number, height: number) {
          g.fillStyle(0x03040b, 1);
          g.fillRoundedRect(x, y, width, height, 18);
          g.fillStyle(0x0d1022, 1);
          g.fillRoundedRect(x + 24, y + 26, width - 48, height - 52, 16);
          g.lineStyle(5, 0xff2bd6, 0.52);
          g.strokeRoundedRect(x, y, width, height, 18);
          g.lineStyle(3, 0x2cf8ff, 0.38);
          g.strokeRoundedRect(x + 24, y + 26, width - 48, height - 52, 16);
          g.fillStyle(0x050711, 1);
          g.fillRoundedRect(x + 82, y + 60, width - 164, 72, 14);
          g.lineStyle(2, 0xffae00, 0.62);
          g.strokeRoundedRect(x + 82, y + 60, width - 164, 72, 14);
          g.fillStyle(0x2cf8ff, 1);
          g.fillRoundedRect(x + 204, y + 82, 22, 30, 5);
          g.fillRoundedRect(x + 234, y + 82, 22, 30, 5);
          g.fillStyle(0xff2bd6, 1);
          g.fillRoundedRect(x + 282, y + 82, 22, 30, 5);
          g.fillRoundedRect(x + 312, y + 82, 88, 10, 5);
          g.fillRoundedRect(x + 312, y + 102, 62, 10, 5);
          g.fillStyle(0xffae00, 1);
          g.fillRoundedRect(x + 428, y + 82, 84, 10, 5);
          g.fillRoundedRect(x + 428, y + 102, 84, 10, 5);
          g.fillStyle(0x050711, 1);
          g.fillRoundedRect(x + width / 2 - 88, y + height - 62, 176, 62, 14);
          g.lineStyle(2, 0xffffff, 0.1);
          g.lineBetween(x + width / 2, y + height - 58, x + width / 2, y + height - 4);
          for (let i = 0; i < 10; i += 1) {
            g.fillStyle(i % 2 === 0 ? 0xffae00 : 0x2cf8ff, 0.72);
            g.fillCircle(x + 70 + i * 78, y + 26, 6);
          }
        }

        private drawBooth(g: any, x: number, y: number, color: number) {
          g.fillStyle(0x03040c, 0.35);
          g.fillEllipse(x + 126, y + 85, 250, 42);
          g.fillStyle(0x090b16, 1);
          g.fillRoundedRect(x, y, 250, 88, 18);
          g.fillStyle(0x040611, 0.96);
          g.fillPoints([
            new Phaser.Geom.Point(x + 12, y + 60),
            new Phaser.Geom.Point(x + 238, y + 60),
            new Phaser.Geom.Point(x + 216, y + 104),
            new Phaser.Geom.Point(x + 34, y + 104),
          ], true);
          g.fillStyle(0x02030a, 0.34);
          g.fillRoundedRect(x + 12, y + 72, 226, 24, 9);
          g.fillStyle(0x11172d, 1);
          g.fillRoundedRect(x + 8, y + 8, 234, 70, 16);
          g.fillStyle(0x151b35, 1);
          g.fillRoundedRect(x + 18, y + 15, 214, 45, 14);
          g.fillStyle(0x222b4d, 0.58);
          g.fillRoundedRect(x + 28, y + 20, 194, 15, 8);
          g.fillStyle(0x080a14, 1);
          g.fillRoundedRect(x + 58, y + 42, 134, 34, 10);
          g.lineStyle(4, color, 0.55);
          g.strokeRoundedRect(x + 14, y + 12, 222, 54, 16);
          g.fillStyle(color, 0.18);
          g.fillRoundedRect(x + 28, y + 72, 194, 16, 8);
          g.fillStyle(color, 0.1);
          g.fillRoundedRect(x + 40, y + 88, 170, 10, 5);
          g.lineStyle(2, 0xffffff, 0.08);
          g.lineBetween(x + 24, y + 22, x + 226, y + 22);
          g.fillStyle(0x010209, 0.75);
          g.fillRoundedRect(x + 28, y + 82, 22, 28, 5);
          g.fillRoundedRect(x + 200, y + 82, 22, 28, 5);
        }

        private drawBottleShelf(g: any, x: number, y: number, width: number) {
          g.fillStyle(0x02030a, 0.5);
          g.fillRoundedRect(x - 8, y + 12, width + 16, 82, 14);
          g.fillStyle(0x050611, 0.96);
          g.fillRoundedRect(x, y, width, 86, 12);
          g.fillStyle(0x0b1126, 0.82);
          g.fillRoundedRect(x + 14, y + 11, width - 28, 64, 9);
          g.lineStyle(2, 0x2cf8ff, 0.16);
          g.strokeRoundedRect(x, y, width, 86, 12);
          for (let row = 0; row < 2; row += 1) {
            g.lineStyle(2, 0xffffff, 0.055);
            g.lineBetween(x + 20, y + 35 + row * 32, x + width - 20, y + 35 + row * 32);
            for (let col = 0; col < 13; col += 1) {
              const bottleX = x + 24 + col * ((width - 48) / 12);
              const bottleColor = col % 3 === 0 ? 0xff2bd6 : col % 3 === 1 ? 0x2cf8ff : 0xffae00;
              const bottleHeight = 22 + ((col + row) % 3) * 4;
              g.fillStyle(0x02030a, 0.45);
              g.fillRoundedRect(bottleX - 3, y + 15 + row * 32, 17, 24, 4);
              g.fillStyle(bottleColor, 0.42);
              g.fillRoundedRect(bottleX, y + 13 + row * 32 - (bottleHeight - 22), 10, bottleHeight, 3);
              g.fillStyle(bottleColor, 0.22);
              g.fillRoundedRect(bottleX + 3, y + 8 + row * 32 - (bottleHeight - 22), 4, 8, 2);
              g.fillStyle(0xffffff, 0.08);
              g.fillRoundedRect(bottleX + 2, y + 16 + row * 32 - (bottleHeight - 22), 3, 12, 2);
            }
          }
        }

        private drawSpeakerStack(g: any, x: number, y: number, accent: number) {
          g.fillStyle(0x010209, 0.42);
          g.fillEllipse(x + 40, y + 126, 96, 24);
          g.fillStyle(0x03040b, 0.98);
          g.fillRoundedRect(x, y, 76, 126, 10);
          g.fillStyle(0x0b1122, 0.96);
          g.fillRoundedRect(x + 8, y + 8, 60, 110, 8);
          g.lineStyle(2, accent, 0.25);
          g.strokeRoundedRect(x, y, 76, 126, 10);
          for (let i = 0; i < 3; i += 1) {
            const cy = y + 27 + i * 36;
            g.fillStyle(0x03040b, 1);
            g.fillCircle(x + 38, cy, 22);
            g.fillStyle(0x10162a, 1);
            g.fillCircle(x + 38, cy, 17);
            g.lineStyle(2, accent, 0.26);
            g.strokeCircle(x + 38, cy, 15);
            g.lineStyle(1, 0xffffff, 0.08);
            g.strokeCircle(x + 38, cy, 9);
            g.fillStyle(accent, 0.12);
            g.fillCircle(x + 38, cy, 6);
          }
          g.lineStyle(2, accent, 0.12);
          g.lineBetween(x + 12, y + 44, x + 64, y + 44);
          g.lineBetween(x + 12, y + 82, x + 64, y + 82);
        }

        private drawFloorPlanter(g: any, x: number, y: number, color: number) {
          g.fillStyle(0x03040c, 0.34);
          g.fillEllipse(x, y + 44, 102, 24);
          g.fillStyle(0x070a14, 1);
          g.fillRoundedRect(x - 32, y + 18, 64, 42, 10);
          g.fillStyle(0x121a2f, 1);
          g.fillRoundedRect(x - 22, y + 26, 44, 24, 8);
          g.lineStyle(2, color, 0.3);
          g.strokeRoundedRect(x - 32, y + 18, 64, 42, 10);
          g.lineStyle(3, 0x2cf8ff, 0.24);
          g.lineBetween(x, y + 24, x - 38, y - 30);
          g.lineStyle(3, 0xff2bd6, 0.22);
          g.lineBetween(x, y + 24, x + 38, y - 30);
          g.fillStyle(color, 0.2);
          g.fillCircle(x, y + 33, 10);
        }

        private drawDanceFloor(g: any) {
          const centerX = roomLayoutForRoom(QORTAL_LAND_DEFAULT_ROOM_ID).width / 2;
          const top = 430;
          const bottom = 645;
          g.fillStyle(0x02040b, 0.45);
          g.fillPoints([
            new Phaser.Geom.Point(centerX - 455, bottom),
            new Phaser.Geom.Point(centerX + 455, bottom),
            new Phaser.Geom.Point(centerX + 405, bottom + 34),
            new Phaser.Geom.Point(centerX - 405, bottom + 34),
          ], true);
          g.fillStyle(0x2cf8ff, 0.055);
          g.fillEllipse(centerX, bottom - 42, 820, 112);
          g.fillStyle(0x0a0d19, 0.96);
          g.fillPoints([
            new Phaser.Geom.Point(centerX - 315, top),
            new Phaser.Geom.Point(centerX + 315, top),
            new Phaser.Geom.Point(centerX + 455, bottom),
            new Phaser.Geom.Point(centerX - 455, bottom),
          ], true);
          for (let row = 0; row < 5; row += 1) {
            for (let col = 0; col < 9; col += 1) {
              const hue = (row * 42 + col * 24) % 360;
              const color = Phaser.Display.Color.HSLToColor(hue / 360, 0.9, 0.55).color;
              const rowY = top + 18 + row * 38;
              const rowWidth = 540 + row * 42;
              const cellW = rowWidth / 9 - 8;
              const startX = centerX - rowWidth / 2 + col * (rowWidth / 9);
              const lit = 0.12 + ((row + col) % 2) * 0.09;
              const skew = row * 5;
              const points = [
                new Phaser.Geom.Point(startX + skew, rowY),
                new Phaser.Geom.Point(startX + cellW + skew, rowY),
                new Phaser.Geom.Point(startX + cellW + skew + 6, rowY + 26),
                new Phaser.Geom.Point(startX + skew - 6, rowY + 26),
              ];
              g.fillStyle(0x010209, 0.3);
              g.fillPoints([
                new Phaser.Geom.Point(points[0].x + 4, points[0].y + 5),
                new Phaser.Geom.Point(points[1].x + 4, points[1].y + 5),
                new Phaser.Geom.Point(points[2].x + 4, points[2].y + 5),
                new Phaser.Geom.Point(points[3].x + 4, points[3].y + 5),
              ], true);
              g.fillStyle(color, lit);
              g.fillPoints(points, true);
              g.fillStyle(0xffffff, 0.035);
              g.fillPoints([
                new Phaser.Geom.Point(points[0].x + 3, points[0].y + 3),
                new Phaser.Geom.Point(points[1].x - 4, points[1].y + 3),
                new Phaser.Geom.Point(points[1].x - 10, points[1].y + 9),
                new Phaser.Geom.Point(points[0].x + 9, points[0].y + 9),
              ], true);
              g.lineStyle(1, color, 0.12);
              g.strokePoints([...points, points[0]], false);
            }
          }
          for (let row = 1; row < 5; row += 1) {
            const y = top + 12 + row * 38;
            const half = 298 + row * 24;
            g.lineStyle(1, 0xf8fbff, 0.055);
            g.lineBetween(centerX - half, y, centerX + half, y + 2);
          }
          g.lineStyle(3, 0xff2bd6, 0.32);
          g.strokePoints([
            new Phaser.Geom.Point(centerX - 315, top),
            new Phaser.Geom.Point(centerX + 315, top),
            new Phaser.Geom.Point(centerX + 455, bottom),
            new Phaser.Geom.Point(centerX - 455, bottom),
            new Phaser.Geom.Point(centerX - 315, top),
          ], false);
          g.lineStyle(2, 0x2cf8ff, 0.18);
          g.lineBetween(centerX - 432, bottom - 6, centerX + 432, bottom - 6);
        }

        private drawBarDetails(g: any) {
          g.fillStyle(0x02030a, 0.4);
          g.fillEllipse(900, 390, 950, 62);
          g.fillStyle(0x2cf8ff, 0.035);
          g.fillEllipse(900, 346, 760, 42);
          g.fillStyle(0x03040b, 1);
          g.fillPoints([
            new Phaser.Geom.Point(420, 338),
            new Phaser.Geom.Point(1380, 338),
            new Phaser.Geom.Point(1330, 400),
            new Phaser.Geom.Point(470, 400),
          ], true);
          g.fillStyle(0x0d1226, 1);
          g.fillPoints([
            new Phaser.Geom.Point(456, 346),
            new Phaser.Geom.Point(1344, 346),
            new Phaser.Geom.Point(1294, 386),
            new Phaser.Geom.Point(506, 386),
          ], true);
          g.fillStyle(0x151c36, 0.78);
          g.fillPoints([
            new Phaser.Geom.Point(492, 352),
            new Phaser.Geom.Point(1308, 352),
            new Phaser.Geom.Point(1278, 374),
            new Phaser.Geom.Point(522, 374),
          ], true);
          g.lineStyle(2, 0x2cf8ff, 0.12);
          g.lineBetween(470, 400, 1330, 400);
          g.lineStyle(2, 0xffffff, 0.055);
          g.lineBetween(506, 356, 1294, 356);
          g.fillStyle(0x050611, 0.98);
          g.fillRoundedRect(420, 314, 960, 54, 14);
          g.fillStyle(0x11172d, 1);
          g.fillRoundedRect(452, 324, 896, 30, 10);
          g.lineStyle(3, 0xff2bd6, 0.34);
          g.strokeRoundedRect(420, 314, 960, 54, 14);
          for (let x = 448; x <= 1320; x += 96) {
            g.fillStyle(0x050611, 0.95);
            g.fillRoundedRect(x, 336, 34, 46, 8);
            g.fillStyle(x % 192 === 0 ? 0xff2bd6 : 0x2cf8ff, 0.46);
            g.fillCircle(x + 17, 332, 10);
            g.fillStyle(0x000000, 0.28);
            g.fillEllipse(x + 17, 383, 42, 14);
            g.fillStyle(0x151b35, 1);
            g.fillRoundedRect(x + 7, 344, 20, 33, 6);
          }
          this.drawBottleShelf(g, 540, 178, 720);
          const hotspot = roomLayoutForRoom(QORTAL_LAND_DEFAULT_ROOM_ID).interactions?.djBooth;
          this.drawDjBooth(g, hotspot?.x ?? 900, 286);
        }

        private drawDjBooth(g: any, x: number, y: number) {
          g.fillStyle(0x010209, 0.42);
          g.fillEllipse(x, y + 82, 310, 42);
          g.fillStyle(0x040611, 0.98);
          g.fillRoundedRect(x - 142, y + 18, 284, 70, 14);
          g.fillStyle(0x101735, 1);
          g.fillRoundedRect(x - 124, y + 28, 248, 42, 10);
          g.lineStyle(3, 0x2cf8ff, 0.36);
          g.strokeRoundedRect(x - 142, y + 18, 284, 70, 14);
          g.lineStyle(2, 0xff2bd6, 0.34);
          g.strokeRoundedRect(x - 92, y + 30, 184, 36, 10);

          for (const deckX of [x - 78, x + 78]) {
            g.fillStyle(0x02030a, 1);
            g.fillCircle(deckX, y + 49, 24);
            g.lineStyle(2, 0x2cf8ff, 0.28);
            g.strokeCircle(deckX, y + 49, 19);
            g.lineStyle(1, 0xf8fbff, 0.12);
            g.strokeCircle(deckX, y + 49, 10);
            g.fillStyle(0xff2bd6, 0.48);
            g.fillCircle(deckX + 6, y + 43, 3);
          }

          g.fillStyle(0x050711, 1);
          g.fillRoundedRect(x - 34, y + 31, 68, 38, 8);
          for (let i = 0; i < 4; i += 1) {
            g.fillStyle(i % 2 === 0 ? 0x2cf8ff : 0xffae00, 0.54);
            g.fillRoundedRect(x - 22 + i * 14, y + 39, 6, 18, 3);
          }
          g.lineStyle(2, 0xff2bd6, 0.18);
          g.lineBetween(x - 106, y + 22, x - 134, y - 8);
          g.lineBetween(x + 106, y + 22, x + 134, y - 8);
          g.fillStyle(0xff2bd6, 0.28);
          g.fillCircle(x - 136, y - 10, 5);
          g.fillStyle(0x2cf8ff, 0.28);
          g.fillCircle(x + 136, y - 10, 5);

          g.fillStyle(0x2cf8ff, 0.14);
          g.fillRoundedRect(x - 118, y + 76, 236, 8, 4);
          g.fillStyle(0xff2bd6, 0.12);
          g.fillRoundedRect(x - 72, y + 88, 144, 7, 4);
        }

        private drawDepthProps() {
          // Club props now come from the transparent PNG development asset pipeline.
        }

        private drawSkywalkDepthProps() {
          const railLayer = this.createPropLayer(410);
          railLayer.fillStyle(0x02040a, 0.72);
          railLayer.fillRoundedRect(180, 382, 1440, 38, 16);
          railLayer.lineStyle(3, 0x2cf8ff, 0.24);
          railLayer.lineBetween(205, 392, 1595, 392);
          for (let x = 240; x <= 1560; x += 120) {
            railLayer.fillStyle(0x2cf8ff, 0.2);
            railLayer.fillRoundedRect(x, 398, 10, 42, 5);
          }
          const kioskLayer = this.createPropLayer(610);
          this.drawBooth(kioskLayer, 1225, 545, 0x2cf8ff);
          this.drawFloorPlanter(kioskLayer, 380, 560, 0xff2bd6);
        }

        private drawMallDepthProps() {
          const signLayer = this.createPropLayer(360);
          signLayer.fillStyle(0x050711, 0.9);
          signLayer.fillRoundedRect(300, 368, 260, 86, 16);
          signLayer.lineStyle(3, 0xffae00, 0.4);
          signLayer.strokeRoundedRect(300, 368, 260, 86, 16);
          signLayer.fillStyle(0xffae00, 0.46);
          signLayer.fillRoundedRect(332, 394, 128, 10, 5);
          signLayer.fillRoundedRect(332, 418, 88, 8, 4);
          const loungeLayer = this.createPropLayer(650);
          this.drawBooth(loungeLayer, 210, 585, 0x2cf8ff);
          this.drawBooth(loungeLayer, 1330, 585, 0xff2bd6);
        }

        private drawParkDepthProps() {
          const railLayer = this.createPropLayer(365);
          railLayer.fillStyle(0x02040a, 0.44);
          railLayer.fillRoundedRect(260, 342, 1280, 24, 12);
          railLayer.lineStyle(3, 0x78ff9a, 0.2);
          railLayer.lineBetween(292, 354, 1508, 354);
          for (let x = 340; x <= 1460; x += 140) {
            railLayer.fillStyle(0x78ff9a, 0.2);
            railLayer.fillRoundedRect(x, 360, 9, 32, 5);
          }

          const midLayer = this.createPropLayer(520);
          this.drawParkBench(midLayer, 245, 468, 0x2cf8ff);
          this.drawParkTree(midLayer, 1580, 490, 0x78ff9a);

          const frontLayer = this.createPropLayer(682);
          this.drawParkTree(frontLayer, 250, 638, 0x2cf8ff);
          this.drawParkTree(frontLayer, 1605, 650, 0x78ff9a);
          this.drawParkBench(frontLayer, 1110, 652, 0xff2bd6);
        }

        private drawLightBeams(g: any) {
          const floor = roomLayoutForRoom(QORTAL_LAND_DEFAULT_ROOM_ID).floor;
          g.fillStyle(0x2cf8ff, 0.032);
          g.fillTriangle(250, 75, 640, floor.bottomY, 860, floor.bottomY);
          g.fillStyle(0xff2bd6, 0.032);
          g.fillTriangle(1540, 80, 950, floor.bottomY, 1190, floor.bottomY);
          g.fillStyle(0xffae00, 0.024);
          g.fillTriangle(900, 40, 720, floor.bottomY, 1080, floor.bottomY);
        }

        private drawForeground(g: any) {
          const roomId = currentRoomRef.current;
          const range = roomFloorRange(roomId);
          const roomSize = roomSizeForRoom(roomId);
          g.fillStyle(0x050611, 0.82);
          g.fillRoundedRect(120, range.bottom + 6, roomSize.width - 240, 46, 18);
          const color =
            roomId === QORTAL_LAND_MALL_ROOM_ID
              ? 0x2cf8ff
              : roomId === QORTAL_LAND_PARK_ROOM_ID
                ? 0x78ff9a
                : 0xff2bd6;
          g.lineStyle(3, color, 0.2);
          g.lineBetween(150, range.bottom + 12, roomSize.width - 150, range.bottom + 12);
        }

        private animateRoom(time: number) {
          if (!this.lightSweep) return;
          this.lightSweep.clear();
          const roomId = currentRoomRef.current;
          if (roomId === QORTAL_LAND_SKYWALK_ROOM_ID) {
            const pulse = 0.5 + Math.sin(time / 260) * 0.5;
            this.lightSweep.fillStyle(0x2cf8ff, 0.035 + pulse * 0.025);
            this.lightSweep.fillEllipse(900, 260, 1180, 58);
            this.lightSweep.fillStyle(0xff2bd6, 0.025);
            this.lightSweep.fillTriangle(250, 46, 850, 666, 1020, 666);
            return;
          }
          if (roomId === QORTAL_LAND_MALL_ROOM_ID) {
            const pulse = 0.5 + Math.sin(time / 220) * 0.5;
            this.lightSweep.fillStyle(0xffae00, 0.035 + pulse * 0.018);
            this.lightSweep.fillEllipse(900, 356, 600, 80);
            this.lightSweep.fillStyle(0x2cf8ff, 0.028);
            this.lightSweep.fillTriangle(900, 310, 560, 700, 1240, 700);
            return;
          }
          if (roomId === QORTAL_LAND_PARK_ROOM_ID) {
            const pulse = 0.5 + Math.sin(time / 360) * 0.5;
            this.lightSweep.fillStyle(0x78ff9a, 0.025 + pulse * 0.018);
            this.lightSweep.fillEllipse(1220, 560, 420, 120);
            this.lightSweep.fillStyle(0x2cf8ff, 0.022);
            this.lightSweep.fillTriangle(1388, 92, 1040, 704, 1420, 704);
            this.lightSweep.fillStyle(0xff2bd6, 0.018);
            this.lightSweep.fillEllipse(520, 470, 360, 70);
            return;
          }
          if (!shouldShowQortalLandProceduralClubShell()) return;
          const layout = roomLayoutForRoom(QORTAL_LAND_DEFAULT_ROOM_ID);
          const sweepX = 260 + ((time / 18) % 1280);
          const pulse = 0.5 + Math.sin(time / 180) * 0.5;
          this.lightSweep.fillStyle(0x2cf8ff, 0.04);
          this.lightSweep.fillTriangle(sweepX - 90, 90, sweepX + 60, layout.floor.bottomY, sweepX + 210, layout.floor.bottomY);
          this.lightSweep.fillStyle(0xff2bd6, 0.035);
          this.lightSweep.fillTriangle(
            layout.width - sweepX + 90,
            95,
            layout.width - sweepX - 90,
            layout.floor.bottomY,
            layout.width - sweepX - 260,
            layout.floor.bottomY
          );
          this.lightSweep.fillStyle(0xff2bd6, 0.04 + pulse * 0.035);
          this.lightSweep.fillEllipse(layout.width / 2, 540, 620 + pulse * 40, 190 + pulse * 22);
          this.lightSweep.fillStyle(0x2cf8ff, 0.055);
          for (let index = 0; index < 5; index += 1) {
            const angle = time / 520 + index * 0.9;
            const x = layout.width / 2 + Math.cos(angle) * 330;
            const y = 520 + Math.sin(angle * 1.3) * 82;
            this.lightSweep.fillCircle(x, y, 12 + pulse * 8);
          }
        }

        private drawChatBubble(background: any, textObject: any) {
          const width = Math.min(250, Math.max(78, Math.ceil(textObject.width) + 28));
          const height = Math.max(34, Math.ceil(textObject.height) + 18);
          background.clear();
          background.fillStyle(0x070914, 0.88);
          background.fillRoundedRect(-width / 2, -height, width, height, 12);
          background.lineStyle(2, 0x2cf8ff, 0.68);
          background.strokeRoundedRect(-width / 2, -height, width, height, 12);
          background.fillStyle(0x070914, 0.88);
          background.fillTriangle(-9, 0, 9, 0, 0, 10);
          background.lineStyle(2, 0x2cf8ff, 0.42);
          background.lineBetween(-9, 0, 0, 10);
          background.lineBetween(9, 0, 0, 10);
          textObject.setPosition(-width / 2 + 14, -height + 9);
        }

        private createChatBubble(bubble: LandChatBubble) {
          const background = this.add.graphics();
          const textObject = this.add.text(0, 0, bubble.text, {
            align: 'center',
            color: '#f8fbff',
            fontFamily: 'Inter, Arial, sans-serif',
            fontSize: '13px',
            lineSpacing: 3,
            wordWrap: { width: 220, useAdvancedWrap: true },
          });
          const container = this.add.container(0, 0, [background, textObject]);
          container.setDepth(9999);
          this.drawChatBubble(background, textObject);
          return { container, background, text: textObject };
        }

        private removeChatBubble(
          messageId: string,
          bubbleObjects = this.chatBubbles.get(messageId)
        ) {
          if (!bubbleObjects) return;
          this.chatBubbles.delete(messageId);
          try {
            if (typeof bubbleObjects.container?.removeAll === 'function') {
              bubbleObjects.container.removeAll(true);
            }
            if (bubbleObjects.container?.scene) {
              bubbleObjects.container.destroy();
            }
          } catch (error) {
            console.warn('[QortalLand] Failed to remove chat bubble', error);
          }
        }

        private updateChatBubbles() {
          const now = Date.now();
          for (const [messageId, bubble] of landChatBubblesRef.current.entries()) {
            if (bubble.expiresAt > now) continue;
            landChatBubblesRef.current.delete(messageId);
          }
          for (const [messageId, bubbleObjects] of this.chatBubbles.entries()) {
            if (landChatBubblesRef.current.has(messageId)) continue;
            this.removeChatBubble(messageId, bubbleObjects);
          }
          for (const [messageId, bubble] of landChatBubblesRef.current.entries()) {
            let avatar: any | undefined;
            if (bubble.authorAddress === myAddress && bubble.sessionId === sessionId) {
              avatar = this.localAvatar;
            } else {
              avatar = this.remotes.get(`${bubble.authorAddress}:${bubble.sessionId}`);
            }
            let bubbleObjects = this.chatBubbles.get(messageId);
            if (!bubbleObjects) {
              bubbleObjects = this.createChatBubble(bubble);
              this.chatBubbles.set(messageId, bubbleObjects);
            }
            if (!avatar) {
              bubbleObjects.container.setVisible(false);
              continue;
            }
            if (bubbleObjects.text.text !== bubble.text) {
              bubbleObjects.text.setText(bubble.text);
              this.drawChatBubble(bubbleObjects.background, bubbleObjects.text);
            }
            const remainingMs = bubble.expiresAt - now;
            const fadeAlpha = Math.max(0, Math.min(1, remainingMs / 2000));
            const ageMs = now - bubble.createdAt;
            const rise = Math.min(12, ageMs / 700);
            const scale = Math.abs(avatar.scaleY || 1);
            bubbleObjects.container.setVisible(true);
            bubbleObjects.container.setPosition(avatar.x, avatar.y - LAND_CHARACTER_CHAT_BUBBLE_OFFSET * scale - rise);
            bubbleObjects.container.setAlpha(remainingMs < 2000 ? fadeAlpha : 1);
            bubbleObjects.container.setDepth(avatar.depth + 120);
          }
        }

        private updateLocalPlayer(delta: number) {
          if (!this.localAvatar) return;
          const step = (190 * delta) / 1000;
          const pressedKeys = movementKeysRef.current;
          const left = pressedKeys.has('arrowleft') || pressedKeys.has('a');
          const right = pressedKeys.has('arrowright') || pressedKeys.has('d');
          const up = pressedKeys.has('arrowup') || pressedKeys.has('w');
          const down = pressedKeys.has('arrowdown') || pressedKeys.has('s');
          let x = Number(this.localAvatar.getData('logicalX'));
          let y = Number(this.localAvatar.getData('logicalY'));
          if (!Number.isFinite(x)) x = localStateRef.current.x;
          if (!Number.isFinite(y)) y = localStateRef.current.y;
          const previousX = x;
          const previousY = y;
          let direction = localStateRef.current.direction;
          if (left) {
            x -= step;
            direction = 'l';
          }
          if (right) {
            x += step;
            direction = 'r';
          }
          if (up) {
            y -= step;
          }
          if (down) {
            y += step;
          }
          if (!left && !right) {
            if (up) {
              direction = 'u';
            } else if (down) {
              direction = 'd';
            }
          }
          let roomId = currentRoomRef.current;
          const desiredX = x;
          const desiredY = y;
          ({ x, y } = clampLandPosition(roomId, x, y));
          if (roomId === QORTAL_LAND_DEFAULT_ROOM_ID) {
            ({ x, y } = this.extendClubSkywalkDoorWalkThrough(desiredX, desiredY, x, y));
          }
          ({ x, y } = resolveQortalLandPropCollisions(
            roomId,
            previousX,
            previousY,
            x,
            y
          ));
          const transition = this.getRoomTransition(roomId, x, y);
          if (transition) {
            roomId = transition.roomId;
            currentRoomRef.current = roomId;
            x = transition.x;
            y = transition.y;
            direction = transition.direction;
            movementKeysRef.current.clear();
            this.drawWorld();
          }
          const moving = Boolean(left || right || up || down);
          const scale = characterScaleForRoomY(roomId, y);
          const localLabelText = displayNameForAddress(myAddress, primaryNameCacheRef.current);
          if (this.localLabel?.text !== localLabelText) {
            this.localLabel?.setText(localLabelText);
          }
          const renderY = qortalLandAvatarRenderY(roomId, x, y);
          this.localAvatar.setData('logicalX', x);
          this.localAvatar.setData('logicalY', y);
          this.localAvatar.setPosition(x, renderY);
          this.localAvatar.setScale(avatarScaleXForDirection(direction, scale), scale);
          this.animateAvatar(this.localAvatar, moving, direction);
          this.localLabel?.setPosition(x, renderY - LAND_CHARACTER_LABEL_OFFSET * scale);
          this.localAvatar.setDepth(y + 20);
          this.localLabel?.setDepth(y + 90);
          localStateRef.current = {
            roomId,
            x,
            y,
            direction,
            movement: moving ? 'walk' : 'idle',
          };
        }

        private extendClubSkywalkDoorWalkThrough(
          desiredX: number,
          desiredY: number,
          clampedX: number,
          clampedY: number
        ): { x: number; y: number } {
          const door = this.clubSkywalkDoor;
          if (!door || door.progress < QORTAL_LAND_CLUB_SKYWALK_DOOR_OPEN_THRESHOLD) {
            return { x: clampedX, y: clampedY };
          }
          if (desiredY < door.passMinY || desiredY > door.passMaxY || desiredX <= clampedX) {
            return { x: clampedX, y: clampedY };
          }
          return {
            x: Math.min(Math.max(clampedX, desiredX), door.passMaxX),
            y: clampedY,
          };
        }

        private getRoomTransition(
          roomId: LandRoomId,
          x: number,
          y: number
        ): { roomId: LandRoomId; x: number; y: number; direction: string } | null {
          const clubLayout = roomLayoutForRoom(QORTAL_LAND_DEFAULT_ROOM_ID);
          const clubToSkywalk = clubLayout.transitions?.clubToSkywalk;
          if (
            roomId === QORTAL_LAND_DEFAULT_ROOM_ID &&
            clubToSkywalk &&
            this.isAtClubSkywalkDoorPassage(x, y)
          ) {
            return clubToSkywalk.target;
          }
          if (
            roomId === QORTAL_LAND_SKYWALK_ROOM_ID &&
            x >= 1548 &&
            y <= 466
          ) {
            return { roomId: QORTAL_LAND_PARK_ROOM_ID, x: 304, y: 500, direction: 'r' };
          }
          if (
            roomId === QORTAL_LAND_SKYWALK_ROOM_ID &&
            x >= 760 &&
            x <= 1040 &&
            y >= 526
          ) {
            return { roomId: QORTAL_LAND_MALL_ROOM_ID, x: 900, y: 565, direction: 'd' };
          }
          if (
            roomId === QORTAL_LAND_SKYWALK_ROOM_ID &&
            x <= 210 &&
            y <= 440
          ) {
            return this.getClubSkywalkDoorReturnTarget();
          }
          if (
            roomId === QORTAL_LAND_MALL_ROOM_ID &&
            x >= 760 &&
            x <= 1040 &&
            y <= 460
          ) {
            return { roomId: QORTAL_LAND_SKYWALK_ROOM_ID, x: 900, y: 470, direction: 'u' };
          }
          if (
            roomId === QORTAL_LAND_PARK_ROOM_ID &&
            x <= 232 &&
            y <= 470
          ) {
            return { roomId: QORTAL_LAND_SKYWALK_ROOM_ID, x: 1488, y: 492, direction: 'l' };
          }
          return null;
        }

        private isAtClubSkywalkDoorPassage(x: number, y: number): boolean {
          const doorProgress = this.clubSkywalkDoor?.progress ?? 0;
          if (doorProgress < QORTAL_LAND_CLUB_SKYWALK_DOOR_OPEN_THRESHOLD) return false;
          const passage = this.clubSkywalkDoor
            ? {
                passMinX: this.clubSkywalkDoor.passMinX,
                passMinY: this.clubSkywalkDoor.passMinY,
                passMaxY: this.clubSkywalkDoor.passMaxY,
              }
            : qortalLandClubSkywalkDoorHotspot();
          return x >= passage.passMinX && y >= passage.passMinY && y <= passage.passMaxY;
        }

        private getClubSkywalkDoorReturnTarget(): QortalLandRoomTransitionTarget {
          const hotspot = qortalLandClubSkywalkDoorHotspot();
          return {
            roomId: QORTAL_LAND_DEFAULT_ROOM_ID,
            x: hotspot.returnX,
            y: hotspot.returnY,
            direction: 'l',
          };
        }

        private updateRemotePlayers() {
          const now = Date.now();
          for (const [key, player] of remotePlayersRef.current.entries()) {
            if (now - player.lastSeenAt > LAND_REMOTE_TTL_MS) {
              remotePlayersRef.current.delete(key);
            }
          }
          for (const [key, avatar] of this.remotes.entries()) {
            const player = remotePlayersRef.current.get(key);
            if (player && player.roomId === currentRoomRef.current) continue;
            avatar.destroy(true);
            this.remotes.delete(key);
            this.remoteLabels.get(key)?.destroy();
            this.remoteLabels.delete(key);
          }
          let remoteIndex = 0;
          for (const [key, player] of remotePlayersRef.current.entries()) {
            if (player.roomId !== currentRoomRef.current) continue;
            let avatar = this.remotes.get(key);
            if (!avatar) {
              const scale = characterScaleForRoomY(player.roomId, player.y);
              const color = Phaser.Display.Color.HSLToColor(
                ((remoteHueBase + remoteIndex * 37) % 360) / 360,
                0.6,
                0.56
              ).color;
              avatar = this.createAvatar(player.x, player.y, color, false);
              this.remotes.set(key, avatar);
              const label = this.add
                .text(
                  player.x,
                  player.y - LAND_CHARACTER_LABEL_OFFSET * scale,
                  displayNameForAddress(player.authorAddress, primaryNameCacheRef.current),
                  {
                    color: '#f8fbff',
                    fontFamily: 'Inter, Arial, sans-serif',
                    fontSize: '12px',
                    stroke: '#10151c',
                    strokeThickness: 4,
                  }
                )
                .setOrigin(0.5);
              this.remoteLabels.set(key, label);
            }
            const elapsedSinceUpdate = now - player.receivedAt;
            const interpolationProgress = Phaser.Math.Clamp(
              elapsedSinceUpdate / player.interpolationMs,
              0,
              1
            );
            const easedProgress = Phaser.Math.Easing.Sine.InOut(interpolationProgress);
            let nextX = Phaser.Math.Linear(player.fromX, player.x, easedProgress);
            let nextY = Phaser.Math.Linear(player.fromY, player.y, easedProgress);
            const afterTargetMs = Math.max(0, elapsedSinceUpdate - player.interpolationMs);
            const shouldPredict =
              player.movement === 'walk' &&
              afterTargetMs > 0 &&
              afterTargetMs <= LAND_REMOTE_EXTRAPOLATE_MS &&
              (Math.abs(player.velocityX) > 0.001 || Math.abs(player.velocityY) > 0.001);
            if (shouldPredict) {
              const velocityLength = Math.hypot(player.velocityX, player.velocityY);
              const maxPredictionMs =
                velocityLength > 0
                  ? Math.min(afterTargetMs, LAND_REMOTE_MAX_EXTRAPOLATE_DISTANCE / velocityLength)
                  : 0;
              const predicted = clampLandPosition(
                player.roomId,
                player.x + player.velocityX * maxPredictionMs,
                player.y + player.velocityY * maxPredictionMs
              );
              nextX = predicted.x;
              nextY = predicted.y;
            }
            player.displayX = nextX;
            player.displayY = nextY;
            const scale = characterScaleForRoomY(player.roomId, nextY);
            const renderY = qortalLandAvatarRenderY(player.roomId, nextX, nextY);
            const label = this.remoteLabels.get(key);
            const labelText = displayNameForAddress(player.authorAddress, primaryNameCacheRef.current);
            if (label?.text !== labelText) {
              label?.setText(labelText);
            }
            avatar.setData('logicalX', nextX);
            avatar.setData('logicalY', nextY);
            avatar.setPosition(nextX, renderY);
            avatar.setScale(avatarScaleXForDirection(player.direction, scale), scale);
            this.animateAvatar(
              avatar,
              player.movement === 'walk' && elapsedSinceUpdate <= LAND_REMOTE_STOP_WALKING_AFTER_MS,
              player.direction
            );
            avatar.setDepth(nextY + 20);
            label?.setPosition(nextX, renderY - LAND_CHARACTER_LABEL_OFFSET * scale);
            label?.setDepth(nextY + 90);
            remoteIndex += 1;
          }
        }
      }

      const width = Math.max(320, containerRef.current.clientWidth || 900);
      const height = Math.max(320, containerRef.current.clientHeight || 560);
      const game = new Phaser.Game({
        type: Phaser.CANVAS,
        parent: containerRef.current,
        backgroundColor: '#050811',
        scale: {
          mode: Phaser.Scale.RESIZE,
          width,
          height,
        },
        scene: QortalLandScene,
      });
      gameRef.current = game;

      const measureContainerSize = () => {
        if (!containerRef.current) return { width, height };
        const rect = containerRef.current.getBoundingClientRect();
        return {
          width: Math.max(320, Math.floor(rect.width || containerRef.current.clientWidth || width)),
          height: Math.max(320, Math.floor(rect.height || containerRef.current.clientHeight || height)),
        };
      };

      const resizeGameToContainer = () => {
        if (destroyed) return;
        const nextSize = measureContainerSize();
        game.scale.resize(nextSize.width, nextSize.height);
      };

      const scheduleGameResize = () => {
        if (destroyed) return;
        if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = 0;
          resizeGameToContainer();
          window.requestAnimationFrame(() => {
            resizeGameToContainer();
          });
        });
      };

      scheduleGameResize();
      window.addEventListener('resize', scheduleGameResize);
      removeWindowResizeListener = () => window.removeEventListener('resize', scheduleGameResize);
      resizeObserver = new ResizeObserver(() => {
        scheduleGameResize();
      });
      resizeObserver.observe(containerRef.current);
    });

    return () => {
      destroyed = true;
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
      removeWindowResizeListener?.();
      resizeObserver?.disconnect();
      gameRef.current?.destroy(true);
      gameRef.current = null;
      remotePlayersRef.current.clear();
      landChatBubblesRef.current.clear();
    };
  }, [myAddress]);

  return (
    <Box
      sx={{
        backgroundColor: '#050811',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        position: 'relative',
        width: '100%',
      }}
    >
      <Box
        sx={{
          alignItems: 'center',
          backgroundColor: 'rgba(9, 13, 18, 0.72)',
          borderBottom: `1px solid ${theme.palette.divider}`,
          display: 'flex',
          gap: 1.5,
          height: 42,
          justifyContent: 'space-between',
          padding: '0 14px',
          zIndex: 2,
        }}
      >
        <Typography sx={{ color: theme.palette.text.primary, fontSize: 14, fontWeight: 700 }}>
          QortalLand
        </Typography>
        <Box sx={{ alignItems: 'center', display: 'flex', gap: 1.25, minWidth: 0 }}>
          <Typography sx={{ color: theme.palette.text.secondary, fontSize: 12 }}>
            {groupName}
          </Typography>
          <Button
            size="small"
            variant={isAssetDevPanelOpen ? 'contained' : 'outlined'}
            onClick={() => setIsAssetDevPanelOpen((open) => !open)}
            sx={{
              borderColor: 'rgba(44, 248, 255, 0.38)',
              borderRadius: '6px',
              color: isAssetDevPanelOpen ? '#071018' : '#2cf8ff',
              fontSize: 11,
              fontWeight: 800,
              lineHeight: 1.1,
              minHeight: 28,
              minWidth: 86,
              padding: '5px 10px',
              textTransform: 'none',
            }}
          >
            Asset Dev
          </Button>
        </Box>
      </Box>
      <Box
        ref={containerRef}
        sx={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          backgroundColor: '#050811',
          overflow: 'hidden',
          width: '100%',
          '& canvas': {
            display: 'block',
          },
        }}
      />
      {isAssetDevPanelOpen && (
        <Box
          sx={{
            backgroundColor: 'rgba(7, 9, 20, 0.94)',
            border: '1px solid rgba(44, 248, 255, 0.26)',
            borderRadius: '8px',
            boxShadow: '0 18px 45px rgba(0, 0, 0, 0.42)',
            color: '#f8fbff',
            display: 'grid',
            gap: 1.1,
            maxHeight: 'calc(100% - 78px)',
            overflowY: 'auto',
            padding: '12px',
            position: 'absolute',
            right: 16,
            top: 54,
            width: 336,
            zIndex: 4,
          }}
        >
          <Typography sx={{ color: '#f8fbff', fontSize: 13, fontWeight: 800 }}>
            Asset Dev
          </Typography>
          <TextField
            label="Asset"
            select
            size="small"
            value={selectedDevPlacementId}
            onChange={(event) => selectDevelopmentPlacement(event.target.value)}
            sx={{
              '& .MuiInputLabel-root': {
                color: 'rgba(248, 251, 255, 0.58)',
                fontSize: 11,
              },
              '& .MuiInputBase-input': {
                color: '#f8fbff',
                fontSize: 12,
              },
              '& .MuiOutlinedInput-notchedOutline': {
                borderColor: 'rgba(248, 251, 255, 0.16)',
              },
              '& .MuiSvgIcon-root': {
                color: 'rgba(248, 251, 255, 0.72)',
              },
            }}
          >
            {QORTAL_LAND_EDITABLE_DEVELOPMENT_PLACEMENTS.map((placement) => (
              <MenuItem key={placement.defaultPlacement.id} value={placement.defaultPlacement.id}>
                {placement.label}
              </MenuItem>
            ))}
          </TextField>
          <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: '1fr 1fr' }}>
            <Button
              size="small"
              variant={devPngPropsEnabled ? 'contained' : 'outlined'}
              onClick={() => setDevelopmentPngPropsEnabled(!devPngPropsEnabled)}
              sx={{
                borderColor: 'rgba(44, 248, 255, 0.38)',
                borderRadius: '6px',
                color: devPngPropsEnabled ? '#071018' : '#2cf8ff',
                fontSize: 11,
                fontWeight: 800,
                textTransform: 'none',
              }}
            >
              PNG Props {devPngPropsEnabled ? 'On' : 'Off'}
            </Button>
            <Button
              size="small"
              variant={proceduralClubShellEnabled ? 'outlined' : 'contained'}
              onClick={() => setProceduralClubShellVisible(!proceduralClubShellEnabled)}
              sx={{
                borderColor: 'rgba(255, 43, 214, 0.38)',
                borderRadius: '6px',
                color: proceduralClubShellEnabled ? '#ff7ce8' : '#071018',
                fontSize: 11,
                fontWeight: 800,
                textTransform: 'none',
              }}
            >
              Phaser Old {proceduralClubShellEnabled ? 'On' : 'Off'}
            </Button>
          </Box>
          <Button
            size="small"
            variant={collisionDebugEnabled ? 'contained' : 'outlined'}
            onClick={() => setCollisionDebugVisible(!collisionDebugEnabled)}
            sx={{
              borderColor: 'rgba(255, 224, 102, 0.42)',
              borderRadius: '6px',
              color: collisionDebugEnabled ? '#17130a' : '#ffe066',
              fontSize: 11,
              fontWeight: 800,
              textTransform: 'none',
            }}
          >
            Collision Debug {collisionDebugEnabled ? 'On' : 'Off'}
          </Button>
          <Typography sx={{ color: '#f8fbff', fontSize: 12, fontWeight: 800 }}>
            Look Dev
          </Typography>
          <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: '1fr 1fr' }}>
            <Button
              size="small"
              variant={developmentLookSettings.enabled ? 'contained' : 'outlined'}
              onClick={() => setDevelopmentLookEnabled(!developmentLookSettings.enabled)}
              sx={{
                borderColor: 'rgba(44, 248, 255, 0.38)',
                borderRadius: '6px',
                color: developmentLookSettings.enabled ? '#071018' : '#2cf8ff',
                fontSize: 11,
                fontWeight: 800,
                textTransform: 'none',
              }}
            >
              Look {developmentLookSettings.enabled ? 'On' : 'Off'}
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={resetDevelopmentLookSettings}
              sx={{
                borderColor: 'rgba(248, 251, 255, 0.2)',
                borderRadius: '6px',
                color: 'rgba(248, 251, 255, 0.82)',
                fontSize: 11,
                textTransform: 'none',
              }}
            >
              Reset Look
            </Button>
          </Box>
          <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: '1fr 1fr' }}>
            {([
              ['brightness', 'Brightness', 0.01],
              ['contrast', 'Contrast', 0.01],
              ['saturation', 'Saturation', 0.01],
              ['shadow', 'Shadow', 0.01],
            ] as const).map(([field, label, step]) => (
              <TextField
                key={field}
                label={label}
                size="small"
                type="number"
                value={developmentLookSettings[field]}
                onChange={(event) =>
                  updateDevelopmentLookSetting(field, event.target.value)
                }
                inputProps={{ step }}
                sx={{
                  '& .MuiInputLabel-root': {
                    color: 'rgba(248, 251, 255, 0.58)',
                    fontSize: 11,
                  },
                  '& .MuiInputBase-input': {
                    color: '#f8fbff',
                    fontSize: 12,
                    padding: '9px 10px',
                  },
                  '& .MuiOutlinedInput-notchedOutline': {
                    borderColor: 'rgba(248, 251, 255, 0.16)',
                  },
                  '& .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline': {
                    borderColor: 'rgba(44, 248, 255, 0.38)',
                  },
                }}
              />
            ))}
          </Box>
          <Typography sx={{ color: 'rgba(248, 251, 255, 0.62)', fontSize: 11, lineHeight: 1.35 }}>
            {qortalLandDevelopmentPngAssetById.has(selectedDevPlacementMeta.defaultPlacement.assetId)
              ? `Loaded: ${selectedDevPlacementMeta.sourceLabel}`
              : `Missing: ${selectedDevPlacementMeta.sourceLabel}`}
          </Typography>
          <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: '1fr 1fr' }}>
            {([
              ['x', 'X', 1],
              ['y', 'Y', 1],
              ...(selectedDevPlacementMeta.allowSeparateScale
                ? [
                    ['scaleX', 'Scale X', 0.01],
                    ['scaleY', 'Scale Y', 0.01],
                  ]
                : [['scale', 'Scale', 0.01]]),
              ['depth', 'Depth', 1],
              ['originX', 'Origin X', 0.001],
              ['originY', 'Origin Y', 0.001],
              ['alpha', 'Alpha', 0.01],
            ] as const).map(([field, label, step]) => (
              <TextField
                key={field}
                label={label}
                size="small"
                type="number"
                value={
                  field === 'scaleX'
                    ? selectedDevPlacement.scaleX ?? selectedDevPlacement.scale ?? ''
                    : field === 'scaleY'
                      ? selectedDevPlacement.scaleY ?? selectedDevPlacement.scale ?? ''
                      : selectedDevPlacement[field] ?? (field === 'alpha' ? 1 : '')
                }
                onChange={(event) =>
                  updateSelectedDevelopmentPlacement(field, event.target.value)
                }
                inputProps={{ step }}
                sx={{
                  '& .MuiInputLabel-root': {
                    color: 'rgba(248, 251, 255, 0.58)',
                    fontSize: 11,
                  },
                  '& .MuiInputBase-input': {
                    color: '#f8fbff',
                    fontSize: 12,
                    padding: '9px 10px',
                  },
                  '& .MuiOutlinedInput-notchedOutline': {
                    borderColor: 'rgba(248, 251, 255, 0.16)',
                  },
                  '& .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline': {
                    borderColor: 'rgba(44, 248, 255, 0.38)',
                  },
                }}
              />
            ))}
          </Box>
          {selectedDevPlacementMeta.allowGroupControls && (
            <>
              <Typography sx={{ color: '#f8fbff', fontSize: 12, fontWeight: 800 }}>
                Group
              </Typography>
              <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: '1fr 1fr' }}>
                {([
                  ['count', 'Count', 1],
                  ['spacing', 'Spacing', 1],
                ] as const).map(([field, label, step]) => (
                  <TextField
                    key={field}
                    label={label}
                    size="small"
                    type="number"
                    value={selectedDevPlacement[field] ?? (field === 'count' ? 1 : 0)}
                    onChange={(event) =>
                      updateSelectedDevelopmentPlacement(field, event.target.value)
                    }
                    inputProps={{ step }}
                    sx={{
                      '& .MuiInputLabel-root': {
                        color: 'rgba(248, 251, 255, 0.58)',
                        fontSize: 11,
                      },
                      '& .MuiInputBase-input': {
                        color: '#f8fbff',
                        fontSize: 12,
                        padding: '9px 10px',
                      },
                      '& .MuiOutlinedInput-notchedOutline': {
                        borderColor: 'rgba(248, 251, 255, 0.16)',
                      },
                      '& .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline': {
                        borderColor: 'rgba(44, 248, 255, 0.38)',
                      },
                    }}
                  />
                ))}
              </Box>
            </>
          )}
          {selectedDevPlacementMeta.allowWarp && (
            <>
              <Typography sx={{ color: '#f8fbff', fontSize: 12, fontWeight: 800 }}>
                Warp
              </Typography>
              <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: '1fr 1fr' }}>
                {([
                  ['tlX', 'TL X'],
                  ['tlY', 'TL Y'],
                  ['trX', 'TR X'],
                  ['trY', 'TR Y'],
                  ['brX', 'BR X'],
                  ['brY', 'BR Y'],
                  ['blX', 'BL X'],
                  ['blY', 'BL Y'],
                ] as const).map(([field, label]) => (
                  <TextField
                    key={field}
                    label={label}
                    size="small"
                    type="number"
                    value={selectedDevPlacement.warp?.[field] ?? 0}
                    onChange={(event) =>
                      updateSelectedDevelopmentWarp(field, event.target.value)
                    }
                    inputProps={{ step: 1 }}
                    sx={{
                      '& .MuiInputLabel-root': {
                        color: 'rgba(248, 251, 255, 0.58)',
                        fontSize: 11,
                      },
                      '& .MuiInputBase-input': {
                        color: '#f8fbff',
                        fontSize: 12,
                        padding: '9px 10px',
                      },
                      '& .MuiOutlinedInput-notchedOutline': {
                        borderColor: 'rgba(248, 251, 255, 0.16)',
                      },
                      '& .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline': {
                        borderColor: 'rgba(44, 248, 255, 0.38)',
                      },
                    }}
                  />
                ))}
              </Box>
            </>
          )}
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
            <Button
              size="small"
              variant="outlined"
              onClick={resetSelectedDevelopmentPlacement}
              sx={{
                borderColor: 'rgba(248, 251, 255, 0.2)',
                borderRadius: '6px',
                color: 'rgba(248, 251, 255, 0.82)',
                fontSize: 11,
                textTransform: 'none',
              }}
            >
              Reset {selectedDevPlacementMeta.label}
            </Button>
          </Box>
        </Box>
      )}
      {reticulumReady === true && (
        <Box
          sx={{
            alignItems: 'center',
            backgroundColor: 'rgba(7, 9, 20, 0.82)',
            border: '1px solid rgba(44, 248, 255, 0.24)',
            borderRadius: '8px',
            bottom: 16,
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
            display: 'flex',
            gap: 1,
            left: '50%',
            maxWidth: 620,
            padding: '8px 10px',
            position: 'absolute',
            transform: 'translateX(-50%)',
            width: 'min(620px, calc(100% - 32px))',
            zIndex: 3,
          }}
        >
          <TextField
            autoComplete="off"
            error={Boolean(chatError)}
            helperText={chatError || `${utf8ByteLength(chatText.trim())}/${LAND_CHAT_MAX_TEXT_BYTES} bytes`}
            placeholder="Say something"
            size="small"
            value={chatText}
            variant="filled"
            onChange={(event) => {
              const next = event.target.value.slice(0, LAND_CHAT_MAX_INPUT_CHARS);
              setChatText(next);
              if (chatError) setChatError('');
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void sendLandChat();
              }
            }}
            sx={{
              flex: 1,
              '& .MuiFilledInput-root': {
                backgroundColor: 'rgba(11, 16, 32, 0.92)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '6px',
                color: theme.palette.text.primary,
                fontSize: 13,
                minHeight: 42,
                overflow: 'hidden',
                '&:before, &:after': { display: 'none' },
              },
              '& .MuiFormHelperText-root': {
                color: chatError ? theme.palette.error.light : 'rgba(248, 251, 255, 0.52)',
                fontSize: 10,
                lineHeight: 1.2,
                marginLeft: 0.5,
                marginTop: 0.35,
              },
            }}
          />
          <IconButton
            aria-label="Send QortalLand chat"
            disabled={isSendingChat || !chatText.trim()}
            onClick={() => void sendLandChat()}
            sx={{
              backgroundColor: 'rgba(44, 248, 255, 0.16)',
              border: '1px solid rgba(44, 248, 255, 0.28)',
              borderRadius: '6px',
              color: '#2cf8ff',
              height: 42,
              width: 42,
              '&:hover': {
                backgroundColor: 'rgba(44, 248, 255, 0.24)',
              },
              '&.Mui-disabled': {
                color: 'rgba(248, 251, 255, 0.3)',
              },
            }}
          >
            <SendRoundedIcon fontSize="small" />
          </IconButton>
        </Box>
      )}
      {reticulumReady === false && (
        <Box
          sx={{
            alignItems: 'center',
            backgroundColor: 'rgba(9, 13, 18, 0.86)',
            bottom: 0,
            display: 'flex',
            justifyContent: 'center',
            left: 0,
            position: 'absolute',
            right: 0,
            top: 42,
            zIndex: 3,
          }}
        >
          <Typography sx={{ color: theme.palette.text.secondary, fontSize: 14 }}>
            Reticulum chat is disabled
          </Typography>
        </Box>
      )}
    </Box>
  );
}
