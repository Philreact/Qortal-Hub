import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectVoiceCallGlobalOverlay } from './DirectVoiceCallGlobalOverlay';

const mocks = vi.hoisted(() => ({
  acceptCall: vi.fn(),
  rejectCall: vi.fn(),
  confirmCallSwitch: vi.fn(async () => true),
  startRingtone: vi.fn(() => vi.fn()),
}));

vi.mock('../../context/VoiceCallContext', () => ({
  useVoiceCallContext: () => ({
    callState: 'ringing',
    incomingCall: {
      chatId: 'direct:Qcaller:Qlocal',
      fromAddress: 'Qcaller',
    },
    acceptCall: mocks.acceptCall,
    rejectCall: mocks.rejectCall,
  }),
}));

vi.mock('../../contexts/CallSwitchGuardContext', () => ({
  useCallSwitchGuard: () => ({
    confirmCallSwitch: mocks.confirmCallSwitch,
  }),
}));

vi.mock('../../lib/call/directIncomingRingtone', () => ({
  startDirectIncomingRingtone: mocks.startRingtone,
}));

vi.mock('../Group/groupApi', () => ({
  getPrimaryNameForAvatar: vi.fn(async () => 'Caller'),
}));

vi.mock('../Group/qortalGroupCallParticipantUi', () => ({
  addrHue: () => '#123456',
  initialsFromDisplayLabel: () => 'C',
  qortalAvatarThumbnailSrc: () => '',
  shortAddr: (address: string) => address,
}));

describe('DirectVoiceCallGlobalOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps ringing without opening a competing dialog while the app is locked', async () => {
    const { rerender } = render(<DirectVoiceCallGlobalOverlay isAppLocked />);

    await waitFor(() => expect(mocks.startRingtone).toHaveBeenCalledOnce());
    expect(screen.queryByText('Incoming voice call')).not.toBeInTheDocument();

    rerender(<DirectVoiceCallGlobalOverlay isAppLocked={false} />);

    expect(await screen.findByText('Incoming voice call')).toBeVisible();
    expect(mocks.startRingtone).toHaveBeenCalledOnce();
  });
});
