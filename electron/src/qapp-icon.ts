import { promises as fs } from 'fs';
import sharp from 'sharp';
import type { QAppLaunch } from './qapp-launch';

export type QAppIconSource = {
  fallbackPng: string;
  fetchAvatar?: (name: string) => Promise<Buffer | null>;
};

export async function qAppIconPng(
  identity: QAppLaunch,
  source: QAppIconSource,
  size = 256
): Promise<Buffer> {
  let input: Buffer | null = null;
  try {
    input = (await source.fetchAvatar?.(identity.name)) ?? null;
    if (input) {
      const metadata = await sharp(input).metadata();
      if (!metadata.width || !metadata.height) input = null;
    }
  } catch {
    input = null;
  }
  return sharp(input ?? (await fs.readFile(source.fallbackPng)))
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

export function pngToIco(png: Buffer): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

export async function pngToIcns(png: Buffer): Promise<Buffer> {
  const sizes: Array<[string, number]> = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ];
  const chunks = await Promise.all(
    sizes.map(async ([type, size]) => {
      const image = await sharp(png).resize(size, size).png().toBuffer();
      const header = Buffer.alloc(8);
      header.write(type, 0, 'ascii');
      header.writeUInt32BE(image.length + 8, 4);
      return Buffer.concat([header, image]);
    })
  );
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(
    8 + chunks.reduce((total, chunk) => total + chunk.length, 0),
    4
  );
  return Buffer.concat([header, ...chunks]);
}
