import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProximityVoiceControl } from './ProximityVoiceControl';

const baseProps: React.ComponentProps<typeof ProximityVoiceControl> = {
  state: 'off',
  mode: 'push-to-talk',
  pttKey: 'v',
  transmitting: false,
  peers: [],
  error: '',
  devices: [],
  inputDeviceId: '',
  outputDeviceId: '',
  masterVolume: 1,
  resolveName: (address) => address,
  onEnable: vi.fn(async () => {}),
  onDisable: vi.fn(async () => {}),
  onMode: vi.fn(),
  onPttKey: vi.fn(),
  onInputDevice: vi.fn(),
  onOutputDevice: vi.fn(),
  onMasterVolume: vi.fn(),
  onPeerPolicy: vi.fn(),
};

describe('ProximityVoiceControl', () => {
  it('enables voice directly from the Voice button', async () => {
    const onEnable = vi.fn(async () => {});
    render(<ProximityVoiceControl {...baseProps} onEnable={onEnable} />);

    fireEvent.click(screen.getByRole('button', { name: 'Enable proximity voice' }));
    await waitFor(() => expect(onEnable).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows PTT guidance and nearby peer controls while active', () => {
    render(
      <ProximityVoiceControl
        {...baseProps}
        state="ready"
        peers={[{
          address: 'Qpeer', sourceId: 1, state: 'connected', distance: 120,
          gain: 0.9, pan: 0.2, audible: true, muted: false, volume: 1,
          speaking: true,
        }]}
        resolveName={() => 'Nearby friend'}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Proximity voice' }));
    expect(screen.getByRole('button', { name: 'Hold V to talk' })).toBeTruthy();
    expect(screen.getByText('Nearby friend')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mute Nearby friend' })).toBeTruthy();
  });
});
