import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchQAppHostRequest,
  isQAppHostBackendAction,
} from './qapp-host-request';

const dispatchers = vi.hoisted(() => ({
  reticulum: vi.fn(async () => 'rns-result'),
  privateChannel: vi.fn(async () => 'private-result'),
  moq: vi.fn(async () => 'moq-result'),
}));

vi.mock('./qapp-reticulum-request', async (importOriginal) => ({
  ...(await importOriginal()),
  dispatchQAppReticulumRequest: dispatchers.reticulum,
}));
vi.mock('./qapp-private-channel-request', async (importOriginal) => ({
  ...(await importOriginal()),
  dispatchQAppPrivateChannelRequest: dispatchers.privateChannel,
}));
vi.mock('./qapp-moq-request', async (importOriginal) => ({
  ...(await importOriginal()),
  dispatchQAppMoqRequest: dispatchers.moq,
}));

const appInfo = {
  name: 'Qortal Together',
  service: 'APP',
  tabId: 'trusted-host-tab',
  hostRequestId: 'trusted-host-request',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('standalone Q-App request routing', () => {
  it.each([
    ['RNS_CONNECT', 'reticulum', 'rns-result'],
    ['RNS_REQUEST', 'reticulum', 'rns-result'],
    ['RNS_SEND', 'reticulum', 'rns-result'],
    ['RNS_CLOSE', 'reticulum', 'rns-result'],
    ['PRIVATE_CHANNEL_OPEN', 'privateChannel', 'private-result'],
    ['PRIVATE_CHANNEL_SEND', 'privateChannel', 'private-result'],
    ['PRIVATE_CHANNEL_STATUS', 'privateChannel', 'private-result'],
    ['PRIVATE_CHANNEL_CLOSE', 'privateChannel', 'private-result'],
    ['MOQ_SESSION_OPEN', 'moq', 'moq-result'],
    ['MOQ_TRACK_SUBSCRIBE', 'moq', 'moq-result'],
    ['MOQ_OBJECT_PUBLISH', 'moq', 'moq-result'],
    ['MOQ_SESSION_METRICS', 'moq', 'moq-result'],
    ['MOQ_SESSION_CLOSE', 'moq', 'moq-result'],
  ] as const)(
    'routes %s through trusted Hub %s',
    async (action, target, result) => {
      const request = {
        action,
        payload: { action: 'FORGED_ACTION', destination: 'a'.repeat(32) },
        timeout: 130_000,
        isExtension: true,
        appInfo,
      };
      expect(isQAppHostBackendAction(action)).toBe(true);
      expect(await dispatchQAppHostRequest(request)).toBe(result);
      expect(dispatchers[target]).toHaveBeenCalledWith(
        { ...request.payload, action },
        {
          appName: appInfo.name,
          appService: appInfo.service,
          tabId: appInfo.tabId,
          hostRequestId: appInfo.hostRequestId,
          isFromExtension: true,
        }
      );
    }
  );

  it.each([
    'SIGN_QAPP_IDENTITY',
    'GET_PRIMARY_NAME',
    'SESSION_PERMISSIONS',
    'ENCRYPT_DATA',
    'DECRYPT_DATA',
  ])('keeps %s on the existing Hub request bridge', async (action) => {
    const sendMessage = vi.fn(async () => 'hub-result');
    window.sendMessage = sendMessage;
    const payload = { action };
    expect(isQAppHostBackendAction(action)).toBe(false);
    expect(
      await dispatchQAppHostRequest({
        action,
        payload,
        timeout: 130_000,
        isExtension: true,
        appInfo,
      })
    ).toBe('hub-result');
    expect(sendMessage).toHaveBeenCalledWith(
      action,
      payload,
      130_000,
      true,
      appInfo
    );
  });
});
