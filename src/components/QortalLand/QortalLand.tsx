import { Box, Typography, useTheme } from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';

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
const LAND_HEIGHT = 720;
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

const initialPositionForAddress = (address: string): { x: number; y: number } => {
  const hue = addressHue(address);
  return {
    x: 260 + (hue % 10) * 70,
    y: 425 + (hue % 3) * 22,
  };
};

export function QortalLand({ groupId, groupName, myAddress }: QortalLandProps) {
  const theme = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<import('phaser').Game | null>(null);
  const remotePlayersRef = useRef<Map<string, LandPlayerState>>(new Map());
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
  }, [groupId, myAddress, sessionId]);

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
            .text(start.x, start.y - 48, shortAddress(myAddress), {
              color: '#f8fbff',
              fontFamily: 'Inter, Arial, sans-serif',
              fontSize: '12px',
              stroke: '#10151c',
              strokeThickness: 4,
            })
            .setOrigin(0.5);
          this.cameras.main.startFollow(this.localAvatar, true, 0.09, 0.09);
          this.scale.on('resize', this.drawWorld, this);
        }

        update(_time: number, delta: number) {
          this.updateLocalPlayer(delta);
          this.updateRemotePlayers();
        }

        private drawWorld() {
          this.background?.destroy();
          const g = this.add.graphics();
          g.fillStyle(0x101820, 1);
          g.fillRect(0, 0, LAND_WIDTH, LAND_HEIGHT);
          g.fillStyle(0x17334a, 1);
          g.fillRect(0, 0, LAND_WIDTH, 260);
          g.fillStyle(0x1d5d6f, 0.72);
          g.fillTriangle(40, 300, 300, 110, 560, 300);
          g.fillTriangle(430, 315, 780, 80, 1120, 315);
          g.fillTriangle(1000, 300, 1300, 115, 1660, 300);
          g.fillStyle(0x35533a, 1);
          g.fillRect(0, 500, LAND_WIDTH, 220);
          g.fillStyle(0x4f7841, 1);
          for (let x = 0; x < LAND_WIDTH; x += 48) {
            g.fillRoundedRect(x, 485 + ((x / 48) % 2) * 4, 58, 28, 8);
          }
          g.fillStyle(0x6f5137, 1);
          g.fillRoundedRect(260, 390, 260, 30, 8);
          g.fillRoundedRect(760, 340, 320, 30, 8);
          g.fillRoundedRect(1230, 410, 280, 30, 8);
          g.fillStyle(0x284d36, 1);
          for (let x = 120; x < LAND_WIDTH; x += 260) {
            g.fillRect(x + 18, 390, 20, 110);
            g.fillCircle(x + 28, 365, 58);
            g.fillCircle(x - 5, 385, 38);
            g.fillCircle(x + 62, 388, 42);
          }
          this.background = g;
          g.setDepth(-100);
        }

        private createAvatar(x: number, y: number, color: number, local: boolean) {
          const body = this.add.circle(0, 0, local ? 17 : 15, color, 1);
          body.setStrokeStyle(3, local ? 0xd7f4ff : 0x1b2632, 1);
          const face = this.add.circle(0, -10, local ? 10 : 9, 0xf2d4b8, 1);
          const feet = this.add.ellipse(0, 18, 38, 10, 0x000000, 0.22);
          const avatar = this.add.container(x, y, [feet, body, face]);
          avatar.setSize(40, 58);
          return avatar;
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
          x = Phaser.Math.Clamp(x, 80, LAND_WIDTH - 80);
          y = Phaser.Math.Clamp(y, 330, 535);
          const moving = Boolean(left || right || up || down);
          this.localAvatar.setPosition(x, y);
          this.localAvatar.setScale(direction === 'l' ? -1 : 1, 1);
          this.localLabel?.setPosition(x, y - 48);
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
                .text(player.x, player.y - 45, shortAddress(player.authorAddress), {
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
            avatar.setPosition(nextX, nextY);
            avatar.setScale(player.direction === 'l' ? -1 : 1, 1);
            this.remoteLabels.get(key)?.setPosition(nextX, nextY - 45);
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
