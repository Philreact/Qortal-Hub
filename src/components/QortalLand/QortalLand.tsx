import { Box, Typography, useTheme } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPrimaryNamesForAddresses } from '../Group/groupApi';

type LandPlayerState = {
  authorAddress: string;
  sessionId: string;
  sequence: number;
  x: number;
  y: number;
  direction: string;
  movement: string;
  lastSeenAt: number;
};

type LocalLandState = {
  x: number;
  y: number;
  direction: string;
  movement: string;
};

type QortalLandProps = {
  groupId: number;
  groupName: string;
  myAddress: string;
};

const LAND_WIDTH = 1800;
const LAND_HEIGHT = 820;
const FLOOR_TOP_Y = 300;
const FLOOR_BOTTOM_Y = 690;
const LAND_SEND_INTERVAL_MS = 125;
const LAND_HEARTBEAT_MS = 2000;
const LAND_REMOTE_TTL_MS = 15000;

const createSessionId = (): string => {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID().replace(/-/g, '').slice(0, 24);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`.slice(0, 24);
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

const initialPositionForAddress = (address: string): { x: number; y: number } => {
  const hue = addressHue(address);
  return {
    x: 430 + (hue % 8) * 110,
    y: 490 + (hue % 4) * 28,
  };
};

const floorBoundsForY = (y: number): { minX: number; maxX: number } => {
  const ratio = Math.max(0, Math.min(1, (y - FLOOR_TOP_Y) / (FLOOR_BOTTOM_Y - FLOOR_TOP_Y)));
  return {
    minX: 205 - ratio * 130,
    maxX: 1595 + ratio * 130,
  };
};

const floorScaleForY = (y: number): number => {
  const ratio = Math.max(0, Math.min(1, (y - FLOOR_TOP_Y) / (FLOOR_BOTTOM_Y - FLOOR_TOP_Y)));
  return 0.78 + ratio * 0.36;
};

export function QortalLand({ groupId, groupName, myAddress }: QortalLandProps) {
  const theme = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<import('phaser').Game | null>(null);
  const remotePlayersRef = useRef<Map<string, LandPlayerState>>(new Map());
  const primaryNameCacheRef = useRef<Map<string, string>>(new Map());
  const pendingPrimaryNameLookupsRef = useRef<Set<string>>(new Set());
  const primaryNameLookupTimerRef = useRef<number | null>(null);
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
  const [reticulumReady, setReticulumReady] = useState<boolean | null>(null);
  const sessionId = useMemo(() => createSessionId(), []);

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
    if (!Number.isInteger(groupId) || groupId <= 0 || !myAddress) return;
    void window.reticulumChat?.subscribeGroup?.(groupId);
    const unsubscribe = window.reticulumChat?.onLandState?.((payload) => {
      if (payload.groupId !== groupId) return;
      if (payload.authorAddress === myAddress && payload.sessionId === sessionId) return;
      queuePrimaryNameLookups([payload.authorAddress]);
      const key = `${payload.authorAddress}:${payload.sessionId}`;
      if (payload.movement === 'leave') {
        remotePlayersRef.current.delete(key);
        return;
      }
      const existing = remotePlayersRef.current.get(key);
      if (existing && payload.sequence <= existing.sequence) return;
      remotePlayersRef.current.set(key, {
        authorAddress: payload.authorAddress,
        sessionId: payload.sessionId,
        sequence: payload.sequence,
        x: payload.x,
        y: payload.y,
        direction: payload.direction || existing?.direction || 'r',
        movement: payload.movement || 'idle',
        lastSeenAt: Date.now(),
      });
    });
    return () => {
      unsubscribe?.();
      void window.reticulumChat?.sendLandState?.(groupId, myAddress, {
        sessionId,
        sequence: sequenceRef.current + 1,
        ...localStateRef.current,
        movement: 'leave',
      });
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

    void import('phaser').then((Phaser) => {
      if (destroyed || !containerRef.current) return;
      const localHue = addressHue(myAddress);
      const localColor = Phaser.Display.Color.HSLToColor(localHue / 360, 0.62, 0.58).color;
      const remoteHueBase = (localHue + 145) % 360;

      class QortalLandScene extends Phaser.Scene {
        private cursors?: any;
        private keys?: Record<string, any>;
        private localAvatar?: any;
        private localLabel?: any;
        private remotes = new Map<string, any>();
        private remoteLabels = new Map<string, any>();
        private background?: any;
        private lightSweep?: any;
        private foreground?: any;
        private propLayers: any[] = [];

        constructor() {
          super('QortalLandScene');
        }

        create() {
          this.cameras.main.setBounds(0, 0, LAND_WIDTH, LAND_HEIGHT);
          this.drawWorld();
          this.cursors = this.input.keyboard?.createCursorKeys();
          this.keys = this.input.keyboard?.addKeys('W,A,S,D') as Record<string, any>;
          const start = localStateRef.current;
          this.localAvatar = this.createAvatar(start.x, start.y, localColor, true);
          this.localLabel = this.add
            .text(start.x, start.y - 48, displayNameForAddress(myAddress, primaryNameCacheRef.current), {
              color: '#f8fbff',
              fontFamily: 'Inter, Arial, sans-serif',
              fontSize: '12px',
              stroke: '#10151c',
              strokeThickness: 4,
            })
            .setOrigin(0.5);
          this.localAvatar.setScale(floorScaleForY(start.y));
          this.localAvatar.setDepth(start.y + 20);
          this.localLabel.setDepth(start.y + 90);
          this.cameras.main.centerOn(start.x, start.y);
          this.cameras.main.startFollow(this.localAvatar, true, 1, 1);
          this.scale.on('resize', this.drawWorld, this);
        }

        update(time: number, delta: number) {
          this.animateRoom(time);
          this.updateLocalPlayer(delta);
          this.updateRemotePlayers();
        }

        private drawWorld() {
          this.background?.destroy();
          this.lightSweep?.destroy();
          this.foreground?.destroy();
          this.propLayers.forEach((layer) => layer.destroy());
          this.propLayers = [];
          const g = this.add.graphics();
          g.fillStyle(0x070914, 1);
          g.fillRect(0, 0, LAND_WIDTH, LAND_HEIGHT);
          g.fillStyle(0x10152a, 1);
          g.fillRect(0, 0, LAND_WIDTH, FLOOR_TOP_Y);
          this.drawWallPanels(g);
          this.drawSideWalls(g);
          this.drawCityWindows(g);
          this.drawCeilingRig(g);

          g.fillStyle(0x0c0d19, 1);
          g.fillPoints([
            new Phaser.Geom.Point(205, FLOOR_TOP_Y),
            new Phaser.Geom.Point(1595, FLOOR_TOP_Y),
            new Phaser.Geom.Point(1725, FLOOR_BOTTOM_Y),
            new Phaser.Geom.Point(75, FLOOR_BOTTOM_Y),
          ], true);
          g.lineStyle(3, 0x1be7ff, 0.16);
          g.strokePoints([
            new Phaser.Geom.Point(205, FLOOR_TOP_Y),
            new Phaser.Geom.Point(1595, FLOOR_TOP_Y),
            new Phaser.Geom.Point(1725, FLOOR_BOTTOM_Y),
            new Phaser.Geom.Point(75, FLOOR_BOTTOM_Y),
            new Phaser.Geom.Point(205, FLOOR_TOP_Y),
          ], false);

          this.drawFloorTexture(g);
          g.lineStyle(1, 0x00e7ff, 0.055);
          for (let i = 1; i <= 4; i += 1) {
            const t = i / 5;
            const leftX = 205 - t * 130;
            const rightX = 1595 + t * 130;
            const y = FLOOR_TOP_Y + t * (FLOOR_BOTTOM_Y - FLOOR_TOP_Y);
            g.lineBetween(leftX, y, rightX, y);
          }
          for (let i = 1; i <= 6; i += 1) {
            const t = i / 7;
            const topX = 205 + t * 1390;
            const bottomX = 75 + t * 1650;
            g.lineBetween(topX, FLOOR_TOP_Y, bottomX, FLOOR_BOTTOM_Y);
          }

          g.fillStyle(0x111730, 1);
          g.fillRoundedRect(470, 170, 860, 118, 18);
          g.fillStyle(0x1a2448, 1);
          g.fillRoundedRect(500, 204, 800, 58, 14);
          g.fillStyle(0x090b18, 1);
          g.fillRoundedRect(420, 270, 960, 62, 16);
          g.lineStyle(4, 0xff2bd6, 0.46);
          g.strokeRoundedRect(420, 270, 960, 62, 16);
          g.lineStyle(2, 0x00f0ff, 0.34);
          g.strokeRoundedRect(500, 204, 800, 58, 14);
          for (let x = 545; x <= 1245; x += 70) {
            g.fillStyle(x % 140 === 0 ? 0xff2bd6 : 0x2cf8ff, 0.58);
            g.fillRoundedRect(x, 214, 28, 38, 6);
          }

          g.fillStyle(0x050611, 1);
          g.fillRoundedRect(760, 92, 280, 72, 20);
          g.lineStyle(3, 0xff2bd6, 0.58);
          g.strokeRoundedRect(760, 92, 280, 72, 20);
          g.lineStyle(2, 0x2cf8ff, 0.42);
          g.strokeRoundedRect(778, 110, 244, 36, 14);

          this.drawNeonText(g, 803, 118);
          this.drawDanceFloor(g);
          this.drawLightBeams(g);
          this.background = g;
          g.setDepth(-100);

          this.drawDepthProps();
          this.lightSweep = this.add.graphics();
          this.lightSweep.setDepth(-80);
          this.foreground = this.add.graphics();
          this.drawForeground(this.foreground);
          this.foreground.setDepth(FLOOR_BOTTOM_Y + 170);
        }

        private createAvatar(x: number, y: number, color: number, local: boolean) {
          const glow = this.add.ellipse(0, 25, local ? 54 : 48, local ? 18 : 15, local ? 0x2cf8ff : color, 0.22);
          const shadow = this.add.ellipse(0, 29, local ? 42 : 36, 11, 0x000000, 0.42);
          const coat = this.add.rectangle(0, 0, local ? 31 : 27, local ? 42 : 38, color, 1);
          coat.setStrokeStyle(3, local ? 0x2cf8ff : 0x111827, local ? 0.88 : 0.72);
          const shirt = this.add.rectangle(0, -2, local ? 12 : 10, local ? 32 : 28, 0x0b1020, 1);
          const neck = this.add.rectangle(0, -27, 8, 8, 0xd8a986, 1);
          const face = this.add.circle(0, -38, local ? 13 : 12, 0xf0c19c, 1);
          const hair = this.add.ellipse(0, -46, local ? 27 : 24, 14, 0x101018, 1);
          const visor = this.add.rectangle(0, -39, local ? 20 : 17, 4, local ? 0xff2bd6 : 0x2cf8ff, 0.9);
          const legLeft = this.add.rectangle(-8, 25, 8, 18, 0x0a0d18, 1);
          const legRight = this.add.rectangle(8, 25, 8, 18, 0x0a0d18, 1);
          const avatar = this.add.container(x, y, [
            glow,
            shadow,
            legLeft,
            legRight,
            coat,
            shirt,
            neck,
            face,
            hair,
            visor,
          ]);
          avatar.setSize(54, 80);
          return avatar;
        }

        private createPropLayer(depth: number) {
          const layer = this.add.graphics();
          layer.setDepth(depth);
          this.propLayers.push(layer);
          return layer;
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

        private drawWallPanels(g: any) {
          g.fillStyle(0x090d1d, 0.55);
          for (let x = 0; x < LAND_WIDTH; x += 300) {
            const panelHeight = 112 + ((x / 150) % 3) * 18;
            g.fillRoundedRect(x + 16, 120, 118, panelHeight, 8);
            g.lineStyle(2, x % 300 === 0 ? 0x2cf8ff : 0xff2bd6, 0.08);
            g.strokeRoundedRect(x + 16, 120, 118, panelHeight, 8);
            g.fillStyle(0x050712, 0.62);
            g.fillRoundedRect(x + 32, 138, 86, 16, 4);
            g.fillRoundedRect(x + 32, 164, 62, 10, 3);
            g.fillStyle(0x090d1d, 0.55);
          }
          g.lineStyle(2, 0xff2bd6, 0.06);
          g.lineBetween(0, 258, LAND_WIDTH, 282);
        }

        private drawFloorTexture(g: any) {
          for (let i = 0; i < 14; i += 1) {
            const y = FLOOR_TOP_Y + 26 + (i % 13) * 28;
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
        }

        private drawSideWalls(g: any) {
          g.fillStyle(0x080b19, 0.92);
          g.fillPoints([
            new Phaser.Geom.Point(0, 128),
            new Phaser.Geom.Point(205, FLOOR_TOP_Y),
            new Phaser.Geom.Point(75, FLOOR_BOTTOM_Y),
            new Phaser.Geom.Point(0, FLOOR_BOTTOM_Y + 40),
          ], true);
          g.fillStyle(0x0b1022, 0.92);
          g.fillPoints([
            new Phaser.Geom.Point(LAND_WIDTH, 128),
            new Phaser.Geom.Point(1595, FLOOR_TOP_Y),
            new Phaser.Geom.Point(1725, FLOOR_BOTTOM_Y),
            new Phaser.Geom.Point(LAND_WIDTH, FLOOR_BOTTOM_Y + 40),
          ], true);
          g.lineStyle(2, 0x2cf8ff, 0.055);
          for (let y = 220; y <= 560; y += 170) {
            g.lineBetween(18, y, 155, y + 72);
            g.lineBetween(LAND_WIDTH - 18, y, LAND_WIDTH - 155, y + 72);
          }
          g.lineStyle(3, 0xff2bd6, 0.11);
          g.lineBetween(0, 128, 205, FLOOR_TOP_Y);
          g.lineStyle(3, 0x2cf8ff, 0.11);
          g.lineBetween(LAND_WIDTH, 128, 1595, FLOOR_TOP_Y);
        }

        private drawCityWindows(g: any) {
          for (let tower = 0; tower < 9; tower += 1) {
            const x = 70 + tower * 195;
            const height = 86 + (tower % 4) * 22;
            g.fillStyle(0x060817, 0.82);
            g.fillRect(x, FLOOR_TOP_Y - height - 18, 88, height);
            for (let row = 0; row < 4; row += 1) {
              for (let col = 0; col < 3; col += 1) {
                const lit = (row + col + tower) % 2 === 0;
                g.fillStyle(lit ? 0x2cf8ff : 0x1a2448, lit ? 0.45 : 0.25);
                g.fillRoundedRect(x + 14 + col * 22, FLOOR_TOP_Y - height + 8 + row * 18, 12, 8, 2);
              }
            }
          }
        }

        private drawCeilingRig(g: any) {
          g.lineStyle(5, 0x050611, 0.9);
          g.lineBetween(360, 78, 1440, 78);
          g.lineStyle(2, 0x2cf8ff, 0.16);
          g.lineBetween(360, 78, 760, 165);
          g.lineBetween(1440, 78, 1040, 165);
          for (let x = 460; x <= 1340; x += 176) {
            g.fillStyle(0x090b18, 1);
            g.fillCircle(x, 78, 18);
            g.lineStyle(2, x % 352 === 0 ? 0xff2bd6 : 0x2cf8ff, 0.42);
            g.strokeCircle(x, 78, 14);
          }
          g.fillStyle(0xc7f8ff, 0.62);
          g.fillCircle(900, 86, 28);
          g.fillStyle(0x2cf8ff, 0.14);
          g.fillCircle(900, 86, 46);
          g.lineStyle(1, 0x10152a, 0.5);
          for (let offset = -20; offset <= 20; offset += 10) {
            g.lineBetween(900 + offset, 61, 900 - offset, 111);
            g.lineBetween(875, 86 + offset, 925, 86 - offset);
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
          g.fillStyle(0x11172d, 1);
          g.fillRoundedRect(x + 8, y + 8, 234, 70, 16);
          g.fillStyle(0x151b35, 1);
          g.fillRoundedRect(x + 18, y + 15, 214, 45, 14);
          g.fillStyle(0x080a14, 1);
          g.fillRoundedRect(x + 58, y + 42, 134, 34, 10);
          g.lineStyle(4, color, 0.55);
          g.strokeRoundedRect(x + 14, y + 12, 222, 54, 16);
          g.fillStyle(color, 0.18);
          g.fillRoundedRect(x + 28, y + 72, 194, 16, 8);
          g.lineStyle(2, 0xffffff, 0.08);
          g.lineBetween(x + 24, y + 22, x + 226, y + 22);
        }

        private drawBottleShelf(g: any, x: number, y: number, width: number) {
          g.fillStyle(0x050611, 0.94);
          g.fillRoundedRect(x, y, width, 86, 12);
          g.lineStyle(2, 0x2cf8ff, 0.12);
          g.strokeRoundedRect(x, y, width, 86, 12);
          for (let row = 0; row < 2; row += 1) {
            g.lineStyle(1, 0xffffff, 0.045);
            g.lineBetween(x + 16, y + 30 + row * 32, x + width - 16, y + 30 + row * 32);
            for (let col = 0; col < 13; col += 1) {
              const bottleX = x + 24 + col * ((width - 48) / 12);
              const bottleColor = col % 3 === 0 ? 0xff2bd6 : col % 3 === 1 ? 0x2cf8ff : 0xffae00;
              g.fillStyle(bottleColor, 0.36);
              g.fillRoundedRect(bottleX, y + 13 + row * 32, 10, 22, 3);
              g.fillStyle(0xffffff, 0.08);
              g.fillRoundedRect(bottleX + 2, y + 16 + row * 32, 3, 12, 2);
            }
          }
        }

        private drawSpeakerStack(g: any, x: number, y: number, accent: number) {
          g.fillStyle(0x03040b, 0.98);
          g.fillRoundedRect(x, y, 76, 126, 10);
          g.lineStyle(2, accent, 0.25);
          g.strokeRoundedRect(x, y, 76, 126, 10);
          for (let i = 0; i < 3; i += 1) {
            const cy = y + 27 + i * 36;
            g.fillStyle(0x10162a, 1);
            g.fillCircle(x + 38, cy, 18);
            g.lineStyle(1, accent, 0.24);
            g.strokeCircle(x + 38, cy, 13);
            g.fillStyle(accent, 0.1);
            g.fillCircle(x + 38, cy, 7);
          }
        }

        private drawFloorPlanter(g: any, x: number, y: number, color: number) {
          g.fillStyle(0x03040c, 0.34);
          g.fillEllipse(x, y + 44, 102, 24);
          g.fillStyle(0x070a14, 1);
          g.fillRoundedRect(x - 32, y + 18, 64, 42, 10);
          g.lineStyle(2, color, 0.24);
          g.strokeRoundedRect(x - 32, y + 18, 64, 42, 10);
          for (let i = -2; i <= 2; i += 2) {
            g.lineStyle(4, i % 2 === 0 ? 0x2cf8ff : 0xff2bd6, 0.22);
            g.lineBetween(x, y + 24, x + i * 18, y - 18 - Math.abs(i) * 5);
          }
        }

        private drawDanceFloor(g: any) {
          const centerX = LAND_WIDTH / 2;
          const top = 430;
          const bottom = 645;
          g.fillStyle(0x02040b, 0.45);
          g.fillPoints([
            new Phaser.Geom.Point(centerX - 455, bottom),
            new Phaser.Geom.Point(centerX + 455, bottom),
            new Phaser.Geom.Point(centerX + 405, bottom + 34),
            new Phaser.Geom.Point(centerX - 405, bottom + 34),
          ], true);
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
              g.fillStyle(color, 0.1 + ((row + col) % 2) * 0.07);
              const skew = row * 5;
              g.fillPoints([
                new Phaser.Geom.Point(startX + skew, rowY),
                new Phaser.Geom.Point(startX + cellW + skew, rowY),
                new Phaser.Geom.Point(startX + cellW + skew + 6, rowY + 26),
                new Phaser.Geom.Point(startX + skew - 6, rowY + 26),
              ], true);
            }
          }
          g.lineStyle(3, 0xff2bd6, 0.32);
          g.strokePoints([
            new Phaser.Geom.Point(centerX - 315, top),
            new Phaser.Geom.Point(centerX + 315, top),
            new Phaser.Geom.Point(centerX + 455, bottom),
            new Phaser.Geom.Point(centerX - 455, bottom),
            new Phaser.Geom.Point(centerX - 315, top),
          ], false);
        }

        private drawBarDetails(g: any) {
          g.fillStyle(0x02030a, 0.4);
          g.fillEllipse(900, 390, 950, 62);
          g.fillStyle(0x03040b, 1);
          g.fillPoints([
            new Phaser.Geom.Point(420, 338),
            new Phaser.Geom.Point(1380, 338),
            new Phaser.Geom.Point(1330, 400),
            new Phaser.Geom.Point(470, 400),
          ], true);
          g.lineStyle(2, 0x2cf8ff, 0.12);
          g.lineBetween(470, 400, 1330, 400);
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
          }
          this.drawBottleShelf(g, 540, 178, 720);
        }

        private drawDepthProps() {
          const barLayer = this.createPropLayer(370);
          this.drawBarDetails(barLayer);

          const backLeftBooth = this.createPropLayer(480);
          this.drawBooth(backLeftBooth, 170, 390, 0xff2bd6);
          const backRightBooth = this.createPropLayer(480);
          this.drawBooth(backRightBooth, 1360, 390, 0x2cf8ff);

          const midProps = this.createPropLayer(545);
          this.drawFloorPlanter(midProps, 1480, 520, 0x9a5cff);
          this.drawFloorPlanter(midProps, 320, 520, 0xffae00);

          const frontLeftBooth = this.createPropLayer(665);
          this.drawBooth(frontLeftBooth, 300, 570, 0x9a5cff);
          const frontRightBooth = this.createPropLayer(665);
          this.drawBooth(frontRightBooth, 1220, 570, 0xffae00);

          const speakerLayer = this.createPropLayer(620);
          this.drawSpeakerStack(speakerLayer, 118, 540, 0x2cf8ff);
          this.drawSpeakerStack(speakerLayer, 1606, 540, 0xff2bd6);
        }

        private drawLightBeams(g: any) {
          g.fillStyle(0x2cf8ff, 0.032);
          g.fillTriangle(250, 75, 640, FLOOR_BOTTOM_Y, 860, FLOOR_BOTTOM_Y);
          g.fillStyle(0xff2bd6, 0.032);
          g.fillTriangle(1540, 80, 950, FLOOR_BOTTOM_Y, 1190, FLOOR_BOTTOM_Y);
          g.fillStyle(0xffae00, 0.024);
          g.fillTriangle(900, 40, 720, FLOOR_BOTTOM_Y, 1080, FLOOR_BOTTOM_Y);
        }

        private drawForeground(g: any) {
          g.fillStyle(0x050611, 0.82);
          g.fillRoundedRect(120, FLOOR_BOTTOM_Y + 6, LAND_WIDTH - 240, 46, 18);
          g.lineStyle(3, 0xff2bd6, 0.2);
          g.lineBetween(150, FLOOR_BOTTOM_Y + 12, LAND_WIDTH - 150, FLOOR_BOTTOM_Y + 12);
        }

        private animateRoom(time: number) {
          if (!this.lightSweep) return;
          this.lightSweep.clear();
          const sweepX = 260 + ((time / 18) % 1280);
          const pulse = 0.5 + Math.sin(time / 180) * 0.5;
          this.lightSweep.fillStyle(0x2cf8ff, 0.04);
          this.lightSweep.fillTriangle(sweepX - 90, 90, sweepX + 60, FLOOR_BOTTOM_Y, sweepX + 210, FLOOR_BOTTOM_Y);
          this.lightSweep.fillStyle(0xff2bd6, 0.035);
          this.lightSweep.fillTriangle(LAND_WIDTH - sweepX + 90, 95, LAND_WIDTH - sweepX - 90, FLOOR_BOTTOM_Y, LAND_WIDTH - sweepX - 260, FLOOR_BOTTOM_Y);
          this.lightSweep.fillStyle(0xff2bd6, 0.04 + pulse * 0.035);
          this.lightSweep.fillEllipse(LAND_WIDTH / 2, 540, 620 + pulse * 40, 190 + pulse * 22);
          this.lightSweep.fillStyle(0x2cf8ff, 0.055);
          for (let index = 0; index < 5; index += 1) {
            const angle = time / 520 + index * 0.9;
            const x = LAND_WIDTH / 2 + Math.cos(angle) * 330;
            const y = 520 + Math.sin(angle * 1.3) * 82;
            this.lightSweep.fillCircle(x, y, 12 + pulse * 8);
          }
        }

        private updateLocalPlayer(delta: number) {
          if (!this.localAvatar) return;
          const step = (190 * delta) / 1000;
          const left = this.cursors?.left?.isDown || this.keys?.A?.isDown;
          const right = this.cursors?.right?.isDown || this.keys?.D?.isDown;
          const up = this.cursors?.up?.isDown || this.keys?.W?.isDown;
          const down = this.cursors?.down?.isDown || this.keys?.S?.isDown;
          let x = this.localAvatar.x;
          let y = this.localAvatar.y;
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
            direction = 'u';
          }
          if (down) {
            y += step;
            direction = 'd';
          }
          y = Phaser.Math.Clamp(y, FLOOR_TOP_Y + 24, FLOOR_BOTTOM_Y - 28);
          const bounds = floorBoundsForY(y);
          x = Phaser.Math.Clamp(x, bounds.minX + 35, bounds.maxX - 35);
          const moving = Boolean(left || right || up || down);
          const scale = floorScaleForY(y);
          const localLabelText = displayNameForAddress(myAddress, primaryNameCacheRef.current);
          if (this.localLabel?.text !== localLabelText) {
            this.localLabel?.setText(localLabelText);
          }
          this.localAvatar.setPosition(x, y);
          this.localAvatar.setScale(direction === 'l' ? -scale : scale, scale);
          this.localLabel?.setPosition(x, y - 48 * scale);
          this.localAvatar.setDepth(y + 20);
          this.localLabel?.setDepth(y + 90);
          localStateRef.current = {
            x,
            y,
            direction,
            movement: moving ? 'walk' : 'idle',
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
            if (remotePlayersRef.current.has(key)) continue;
            avatar.destroy(true);
            this.remotes.delete(key);
            this.remoteLabels.get(key)?.destroy();
            this.remoteLabels.delete(key);
          }
          let remoteIndex = 0;
          for (const [key, player] of remotePlayersRef.current.entries()) {
            let avatar = this.remotes.get(key);
            if (!avatar) {
              const color = Phaser.Display.Color.HSLToColor(
                ((remoteHueBase + remoteIndex * 37) % 360) / 360,
                0.6,
                0.56
              ).color;
              avatar = this.createAvatar(player.x, player.y, color, false);
              this.remotes.set(key, avatar);
              const label = this.add
                .text(player.x, player.y - 45, displayNameForAddress(player.authorAddress, primaryNameCacheRef.current), {
                  color: '#f8fbff',
                  fontFamily: 'Inter, Arial, sans-serif',
                  fontSize: '12px',
                  stroke: '#10151c',
                  strokeThickness: 4,
                })
                .setOrigin(0.5);
              this.remoteLabels.set(key, label);
            }
            const nextX = Phaser.Math.Linear(avatar.x, player.x, 0.2);
            const nextY = Phaser.Math.Linear(avatar.y, player.y, 0.2);
            const scale = floorScaleForY(nextY);
            const label = this.remoteLabels.get(key);
            const labelText = displayNameForAddress(player.authorAddress, primaryNameCacheRef.current);
            if (label?.text !== labelText) {
              label?.setText(labelText);
            }
            avatar.setPosition(nextX, nextY);
            avatar.setScale(player.direction === 'l' ? -scale : scale, scale);
            avatar.setDepth(nextY + 20);
            label?.setPosition(nextX, nextY - 45 * scale);
            label?.setDepth(nextY + 90);
            remoteIndex += 1;
          }
        }
      }

      const width = Math.max(320, containerRef.current.clientWidth || 900);
      const height = Math.max(320, containerRef.current.clientHeight || 560);
      const game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: containerRef.current,
        backgroundColor: '#101820',
        scale: {
          mode: Phaser.Scale.RESIZE,
          width,
          height,
        },
        scene: QortalLandScene,
      });
      gameRef.current = game;
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry || destroyed) return;
        game.scale.resize(
          Math.max(320, Math.floor(entry.contentRect.width)),
          Math.max(320, Math.floor(entry.contentRect.height))
        );
      });
      resizeObserver.observe(containerRef.current);
    });

    return () => {
      destroyed = true;
      resizeObserver?.disconnect();
      gameRef.current?.destroy(true);
      gameRef.current = null;
      remotePlayersRef.current.clear();
    };
  }, [myAddress]);

  return (
    <Box
      sx={{
        backgroundColor: '#101820',
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
        <Typography sx={{ color: theme.palette.text.secondary, fontSize: 12 }}>
          {groupName}
        </Typography>
      </Box>
      <Box
        ref={containerRef}
        sx={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          width: '100%',
          '& canvas': {
            display: 'block',
          },
        }}
      />
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
