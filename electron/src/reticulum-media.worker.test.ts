import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { convertAnimatedGifToWebp } from './reticulum-media.worker';

const ANIMATED_GIF_BASE64 =
  'R0lGODlhQAHwAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAAAAAACH/C0ltYWdlTWFnaWNrDmdhbW1hPTAuNDU0NTQ1ACwAAAAAQAHwAAAC/4SPqcvtD6OctNqLs968+w+G4kiW5omm6sq27gvH8kzX9o3n+s73/g8MCofEovGITCqXzKbzCY1Kp9Sq9YrNarfcrvcLDovH5LL5jE6r1+y2+w2Py+f0uv2Oz+v3/L7/DxgoOEhYaHiImKi4yNjo+AgZKTlJWWl5iZmpucnZ6fkJGio6SlpqeoqaqrrK2ur6ChsrO0tba3uLm6u7y9vr+wscLDxMXGx8jJysvMzc7PwMHS09TV1tfY2drb3N3e39DR4uPk5ebn6Onq6+zt7u/g4fLz9PX29/j5+vv8/f7/8PMKDAgQQLGjyIMKHChQwbOnwIMaLEiRQrWryIMaPGjYEcO3r8CDKkyJEkS5o8iTKlypUsW7p8CTOmzJk0a9q8iTOnzp08e/r8CTSo0KFEixo9ijSp0qVMmzp9CjWq1KlUq1q9ijWr1q1cu3r9Cjas2LFky5o9izat2rVs27p9Czeu3Ll069q9izev3r18+/r9Cziw4MGECxs+jDix4sWoCgAAIfkEAAAAAAAh/wtJbWFnZU1hZ2ljaw5nYW1tYT0wLjQ1NDU0NQAsAAAAAEAB8ACAAAD/AAAAAv+Ej6nL7Q+jnLTai7PevPsPhuJIluaJpurKtu4Lx/JM1/aN5/rO9/4PDAqHxKLxiEwql8ym8wmNSqfUqvWKzWq33K73Cw6Lx+Sy+YxOq9fstvsNj8vn9Lr9js/r9/y+/w8YKDhIWGh4iJiouMjY6PgIGSk5SVlpeYmZqbnJ2en5CRoqOkpaanqKmqq6ytrq+gobKztLW2t7i5uru8vb6/sLHCw8TFxsfIycrLzM3Oz8DB0tPU1dbX2Nna29zd3t/Q0eLj5OXm5+jp6uvs7e7v4OHy8/T19vf4+fr7/P3+//DzCgwIEECxo8iDChwoUMGzp8CDGixIkUK1q8iDGjxo2BHDt6/AgypMiRJEuaPIkypcqVLFu6fAkzpsyZNGvavIkzp86dPHv6/Ak0qNChRIsaPYo0qdKlTJs6fQo1qtSpVKtavYo1q9atXLt6/Qo2rNixZMuaPYs2rdq1bNu6fQs3rty5dOvavYs3r969fPv6/Qs4sODBhAsbPow4seLFqAoAADs=';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe('Reticulum animated media conversion', () => {
  it('preserves animation while converting GIF to target-sized WebP', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reticulum-media-test-'));
    tempDirs.push(dir);
    const inputPath = path.join(dir, 'animation.gif');
    const outputPath = path.join(dir, 'animation.webp');
    fs.writeFileSync(inputPath, Buffer.from(ANIMATED_GIF_BASE64, 'base64'));

    const result = await convertAnimatedGifToWebp({
      id: 1,
      kind: 'gif_to_webp',
      inputPath,
      outputPath,
      targetBytes: 500 * 1024,
    });
    const metadata = await sharp(outputPath, { animated: true }).metadata();

    expect(result.targetAchieved).toBe(true);
    expect(result.sizeBytes).toBeLessThanOrEqual(500 * 1024);
    expect(metadata.format).toBe('webp');
    expect(metadata.pages).toBe(2);
    expect(metadata.loop).toBe(0);
    expect(metadata.delay).toEqual([100, 100]);
  });
});
