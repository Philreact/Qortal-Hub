import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { desktopCapturer, ipcMain } from 'electron';
import { installDisplayMediaPicker } from './display-media-picker';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture() {
  const bus = new EventEmitter();
  vi.spyOn(ipcMain, 'on').mockImplementation(((...args: any[]) =>
    bus.on(args[0], args[1])) as any);
  vi.spyOn(ipcMain, 'removeListener').mockImplementation(((...args: any[]) =>
    bus.removeListener(args[0], args[1])) as any);
  const getSources = vi
    .spyOn(desktopCapturer, 'getSources')
    .mockResolvedValue([
      {
        id: 'screen:1',
        name: 'Screen',
        thumbnail: { toDataURL: () => 'data:image/png;base64,AA==' },
      },
    ] as any);
  let handler: any;
  const root = {};
  const frame = {
    detached: false,
    top: root,
    url: 'https://app.test',
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
  };
  const webContents = {
    mainFrame: root,
    send: vi.fn(),
    session: {
      setDisplayMediaRequestHandler: (fn: any) => {
        handler = fn;
      },
    },
  };
  const window = { webContents, isDestroyed: () => false, once: vi.fn() };
  installDisplayMediaPicker(window as any);
  const callback = vi.fn();
  const request = {
    frame,
    userGesture: true,
    videoRequested: true,
    securityOrigin: 'https://app.test',
  };
  handler(request, callback);
  const requestId = webContents.send.mock.calls[0][1].requestId;
  const send = (channel: string, payload: object, trusted = true) =>
    bus.emit(
      channel,
      { sender: trusted ? webContents : {}, senderFrame: root },
      { requestId, ...payload }
    );
  return {
    frame,
    callback,
    send,
    getSources,
    handler,
    request,
    webContents,
    bus,
  };
}

it('does not enumerate before approval and grants only the selected one-use source', async () => {
  const f = fixture();
  expect(f.getSources).not.toHaveBeenCalled();
  f.send('display-media:select', { sourceId: 'screen:1' });
  f.send('display-media:authorize', { accepted: true }, false);
  expect(f.callback).not.toHaveBeenCalled();
  expect(f.getSources).not.toHaveBeenCalled();
  f.send('display-media:authorize', { accepted: true });
  await vi.waitFor(() => expect(f.frame.executeJavaScript).toHaveBeenCalled());
  expect(f.frame.executeJavaScript.mock.calls[0][0]).toContain(
    'QAPP_SCREEN_CAPTURE_SOURCES'
  );
  f.send('display-media:select', { sourceId: 'screen:1', requestId: 'wrong' });
  expect(f.callback).not.toHaveBeenCalled();
  f.send('display-media:select', { sourceId: 'screen:1' });
  expect(f.callback).toHaveBeenCalledWith({
    video: expect.objectContaining({ id: 'screen:1' }),
  });
  f.send('display-media:select', { sourceId: 'screen:1' });
  expect(f.callback).toHaveBeenCalledTimes(1);
  expect(f.bus.listenerCount('display-media:authorize')).toBe(0);
});

it('denies rejection without disclosing thumbnails', () => {
  const f = fixture();
  f.send('display-media:authorize', { accepted: false });
  expect(f.callback).toHaveBeenCalledWith({});
  expect(f.getSources).not.toHaveBeenCalled();
});

it.each(['navigation', 'detached', 'unknown-source'])(
  'denies %s after approval',
  async (failure) => {
    const f = fixture();
    f.send('display-media:authorize', { accepted: true });
    await vi.waitFor(() =>
      expect(f.frame.executeJavaScript).toHaveBeenCalled()
    );
    if (failure === 'navigation') f.frame.url = 'https://elsewhere.test';
    if (failure === 'detached') f.frame.detached = true;
    f.send('display-media:select', {
      sourceId: failure === 'unknown-source' ? 'window:99' : 'screen:1',
    });
    expect(f.callback).toHaveBeenCalledWith({});
  }
);

it('times out and denies concurrent requests and missing gestures', () => {
  vi.useFakeTimers();
  const f = fixture();
  const second = vi.fn();
  f.handler(f.request, second);
  expect(second).toHaveBeenCalledWith({});
  vi.advanceTimersByTime(60_000);
  expect(f.callback).toHaveBeenCalledWith({});
  const third = vi.fn();
  f.handler({ ...f.request, userGesture: false }, third);
  expect(third).toHaveBeenCalledWith({});
});
