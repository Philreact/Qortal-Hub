import Compressor from 'compressorjs';

export const isReticulumCompressibleImage = (file: File) =>
  file.type?.startsWith('image/') === true && file.type !== 'image/gif';

export const isReticulumGifFile = async (file: File): Promise<boolean> => {
  try {
    const header = new Uint8Array(await file.slice(0, 6).arrayBuffer());
    return (
      header.length === 6 &&
      header[0] === 0x47 &&
      header[1] === 0x49 &&
      header[2] === 0x46 &&
      header[3] === 0x38 &&
      (header[4] === 0x37 || header[4] === 0x39) &&
      header[5] === 0x61
    );
  } catch {
    return false;
  }
};

export const convertReticulumGifFile = async (
  file: File,
  targetBytes = 500 * 1024
) => {
  const filePath =
    window.reticulumResources?.getPathForFile?.(file) ||
    (typeof (file as File & { path?: unknown }).path === 'string'
      ? String((file as File & { path?: unknown }).path)
      : '');
  if (filePath) {
    return window.reticulumResources?.convertGifToWebp?.({
      filePath,
      fileName: file.name,
      targetBytes,
    });
  }
  if (file.size <= 0 || file.size > 100 * 1024 * 1024) {
    return {
      success: false,
      error: 'GIF must be between 1 byte and 100 MB',
    };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return window.reticulumResources?.convertGifToWebp?.({
    bytes,
    fileName: file.name,
    targetBytes,
  });
};

export const compressReticulumImageFile = (file: File): Promise<File> =>
  new Promise((resolve) => {
    new Compressor(file, {
      quality: 0.6,
      maxWidth: 1200,
      mimeType: 'image/webp',
      success(result) {
        resolve(
          new File(
            [result],
            `${file.name.replace(/\.[^.]+$/, '') || 'image'}.webp`,
            {
              type: 'image/webp',
              lastModified: Date.now(),
            }
          )
        );
      },
      error(error) {
        console.error('Reticulum image compression error:', error);
        resolve(file);
      },
    });
  });
