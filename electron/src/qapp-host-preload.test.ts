import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('Q-App host preload', () => {
  it('exposes the navbar actions through its sandboxed bridge', async () => {
    const sourcePath = resolve(
      process.cwd(),
      'electron/src/qapp-host-preload.ts'
    );
    const source = readFileSync(sourcePath, 'utf8');
    const code = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: sourcePath,
    }).outputText;
    const channels: string[] = [];
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    let api: Record<string, any>;
    runInNewContext(code, {
      exports: {},
      require: (name: string) => {
        expect(name).toBe('electron');
        return {
          contextBridge: {
            exposeInMainWorld: (key: string, value: typeof api) => {
              if (key === 'electronAPI') api = value;
            },
          },
          ipcRenderer: {
            invoke: async (channel: string) => {
              channels.push(channel);
            },
            on: (channel: string, listener: (event: unknown, payload: unknown) => void) =>
              listeners.set(channel, listener),
            removeListener: (channel: string) => listeners.delete(channel),
          },
        };
      },
    });

    await api!.showHubFromQAppHost();
    await api!.uninstallQAppHost();
    await api!.qappFileSave(
      { tabId: 'tab', name: 'Example', service: 'APP' },
      { action: 'FILE_SAVE_OPEN' }
    );
    const themeModes: string[] = [];
    const unsubscribe = api!.onQAppHostThemeMode!((mode) =>
      themeModes.push(mode)
    );
    listeners.get('qappHost:themeMode')!({}, 'light');
    unsubscribe();
    expect(api!.qappReticulumConnect).toBeUndefined();
    expect(themeModes).toEqual(['light']);
    expect(channels).toEqual([
      'qappHost:showHub',
      'qappHost:uninstall',
      'qappFileSave:request',
    ]);
  });
});
