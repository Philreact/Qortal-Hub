#!/usr/bin/env node

import { chmod, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distPath = path.join(electronDir, 'dist');

function formatMode(mode) {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

async function main() {
  const entries = await readdir(distPath, { withFileTypes: true });
  const appImages = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.AppImage'))
    .map((entry) => path.join(distPath, entry.name))
    .sort();

  if (appImages.length === 0) {
    throw new Error(`No AppImage artifacts found in ${path.relative(electronDir, distPath)}.`);
  }

  for (const appImagePath of appImages) {
    await chmod(appImagePath, 0o755);
    const fileStat = await stat(appImagePath);
    console.log(`Set executable mode ${formatMode(fileStat.mode)} on ${path.relative(electronDir, appImagePath)}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
