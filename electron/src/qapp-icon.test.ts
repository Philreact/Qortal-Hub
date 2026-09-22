import { describe, expect, it } from 'vitest';
import { join } from 'path';
import sharp from 'sharp';
import { pngToIcns, pngToIco, qAppIconPng } from './qapp-icon';

const identity = { service: 'APP' as const, name: 'Q-Tube' };
const fallbackPng = join(__dirname, '../assets/appIcon.png');

describe('Q-App shortcut icons', () => {
  it('converts a WebP name avatar to a PNG icon', async () => {
    const avatar = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 4,
        background: '#ff0000',
      },
    })
      .webp()
      .toBuffer();
    const png = await qAppIconPng(identity, {
      fallbackPng,
      fetchAvatar: async (name) => {
        expect(name).toBe('Q-Tube');
        return avatar;
      },
    });
    const pixel = await sharp(png)
      .extract({ left: 128, top: 128, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect((await sharp(png).metadata()).format).toBe('png');
    expect(pixel[0]).toBeGreaterThan(200);
    expect(pixel[1]).toBeLessThan(40);
    expect(pixel[2]).toBeLessThan(40);
  });

  it('falls back to the Hub icon and builds Windows and macOS icon files', async () => {
    const png = await qAppIconPng(identity, {
      fallbackPng,
      fetchAvatar: async () => null,
    });
    const ico = pngToIco(png);
    const icns = await pngToIcns(png);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt32LE(14)).toBe(png.length);
    expect(ico.subarray(22, 30).equals(png.subarray(0, 8))).toBe(true);
    expect(icns.toString('ascii', 0, 4)).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
  });
});
