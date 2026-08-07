import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('audio-surface sandbox preload', () => {
  it('does not emit runtime requires for local modules', () => {
    const sourcePath = resolve(
      process.cwd(),
      'electron/src/audio-surface-preload.ts'
    );
    const source = readFileSync(sourcePath, 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: sourcePath,
    }).outputText;

    const runtimeRequires = [
      ...output.matchAll(/require\(["']([^"']+)["']\)/g),
    ].map((match) => match[1]);

    expect(runtimeRequires).toEqual(['electron']);
  });
});
