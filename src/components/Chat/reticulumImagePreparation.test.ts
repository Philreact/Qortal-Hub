import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  convertReticulumGifFile,
  isReticulumGifFile,
} from './reticulumImagePreparation';

const gifBytes = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00]);

const mockFile = (bytes: Uint8Array, name = 'pasted.gif') =>
  ({
    arrayBuffer: async () => bytes.slice().buffer,
    name,
    size: bytes.byteLength,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => bytes.slice(start, end).buffer,
    }),
  }) as unknown as File;

afterEach(() => {
  Reflect.deleteProperty(window, 'reticulumResources');
});

describe('Reticulum pasted GIF preparation', () => {
  it('recognizes GIF data by its byte signature', async () => {
    await expect(isReticulumGifFile(mockFile(gifBytes))).resolves.toBe(true);
    await expect(
      isReticulumGifFile(mockFile(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])))
    ).resolves.toBe(false);
  });

  it('sends pathless GIF bytes to the background converter', async () => {
    const convertGifToWebp = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'reticulumResources', {
      configurable: true,
      value: {
        getPathForFile: () => '',
        convertGifToWebp,
      },
    });

    await convertReticulumGifFile(mockFile(gifBytes));

    expect(convertGifToWebp).toHaveBeenCalledOnce();
    const payload = convertGifToWebp.mock.calls[0][0];
    expect(payload.filePath).toBeUndefined();
    expect(payload.fileName).toBe('pasted.gif');
    expect(payload.targetBytes).toBe(500 * 1024);
    expect(Array.from(payload.bytes)).toEqual(Array.from(gifBytes));
  });
});
