import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const bridge = {
    getState: vi.fn(() => 'ready'),
  };
  return {
    bridge,
    setPresenceManagerTransports: vi.fn(),
    getPresenceManager: vi.fn(() => ({})),
    getReticulumBridge: vi.fn(() => bridge),
    setCallBridge: vi.fn(),
    setGroupCallBridge: vi.fn(),
    setChatBridge: vi.fn(),
  };
});

vi.mock('./call', () => ({
  getCallManager: vi.fn(() => ({ setReticulumBridge: mocks.setCallBridge })),
}));

vi.mock('./group-call', () => ({
  getGroupCallManager: vi.fn(() => ({
    setReticulumBridge: mocks.setGroupCallBridge,
  })),
}));

vi.mock('./logger', () => ({
  log: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./presence', () => ({
  getPresenceManager: mocks.getPresenceManager,
  setPresenceManagerTransports: mocks.setPresenceManagerTransports,
}));

vi.mock('./reticulum-bridge', () => ({
  getReticulumBridge: mocks.getReticulumBridge,
}));

vi.mock('./reticulum-chat', () => ({
  getReticulumChatManager: vi.fn(() => ({ setBridge: mocks.setChatBridge })),
}));

import { rebindReticulumBridgeConsumers } from './reticulum-bridge-rebind';

describe('rebindReticulumBridgeConsumers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bridge.getState.mockReturnValue('ready');
    mocks.getReticulumBridge.mockReturnValue(mocks.bridge);
    mocks.getPresenceManager.mockReturnValue({});
  });

  it('rebinds presence, call, group-call, and chat to the ready bridge', () => {
    rebindReticulumBridgeConsumers();

    expect(mocks.setPresenceManagerTransports).toHaveBeenCalledWith([
      mocks.bridge,
    ]);
    expect(mocks.setCallBridge).toHaveBeenCalledWith(mocks.bridge);
    expect(mocks.setGroupCallBridge).toHaveBeenCalledWith(mocks.bridge);
    expect(mocks.setChatBridge).toHaveBeenCalledWith(mocks.bridge);
  });

  it('does not rebind consumers when the bridge is not ready', () => {
    mocks.bridge.getState.mockReturnValue('starting');

    rebindReticulumBridgeConsumers();

    expect(mocks.setPresenceManagerTransports).not.toHaveBeenCalled();
    expect(mocks.setCallBridge).not.toHaveBeenCalled();
    expect(mocks.setGroupCallBridge).not.toHaveBeenCalled();
    expect(mocks.setChatBridge).not.toHaveBeenCalled();
  });
});
