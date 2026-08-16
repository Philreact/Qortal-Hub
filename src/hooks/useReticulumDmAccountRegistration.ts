import { useCallback, useEffect, useRef } from 'react';

type ReticulumDmAddressRegistrar = (
  addresses: string[]
) => Promise<{ success: boolean; error?: string }>;

type ReticulumReadinessStatus = {
  state: 'idle' | 'starting' | 'ready' | 'failed';
  revision: number;
  error?: string;
};

type ReticulumReadinessSubscriber = (
  callback: (status: ReticulumReadinessStatus) => void
) => () => void;

type ReticulumDmAccountRegistrationOptions = {
  managed?: boolean;
  authenticated: boolean;
  enabled: boolean;
  address: string;
  register?: ReticulumDmAddressRegistrar;
  onReadinessChanged?: ReticulumReadinessSubscriber;
};

export const resolveReticulumDmAccountAddresses = ({
  authenticated,
  enabled,
  address,
}: Omit<ReticulumDmAccountRegistrationOptions, 'register'>): string[] => {
  const normalizedAddress = String(address || '').trim();
  return authenticated && enabled && normalizedAddress
    ? [normalizedAddress]
    : [];
};

/**
 * Keeps main-process DM ownership aligned with the authenticated account.
 *
 * This belongs to the application lifecycle rather than an individual chat
 * screen: incoming DMs must remain active while Q-Chat is closed or another
 * authenticated view is mounted. Updates are serialized so a slower IPC call
 * for an old account cannot overwrite a newer account registration.
 */
export const useReticulumDmAccountRegistration = ({
  managed = true,
  authenticated,
  enabled,
  address,
  register = window.reticulumChat?.setLocalDmAddresses,
  onReadinessChanged = window.reticulumChat?.onReadinessChanged,
}: ReticulumDmAccountRegistrationOptions): void => {
  const revisionRef = useRef(0);
  const updateQueueRef = useRef<Promise<void>>(Promise.resolve());
  const desiredAddressesRef = useRef<string[]>([]);

  desiredAddressesRef.current = resolveReticulumDmAccountAddresses({
    authenticated,
    enabled,
    address,
  });

  const queueRegistration = useCallback(
    (addresses: string[]) => {
      if (typeof register !== 'function') return;

      const revision = ++revisionRef.current;
      updateQueueRef.current = updateQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          // If this update was superseded before it started, only apply the
          // newest authenticated state.
          if (revision !== revisionRef.current) return;
          const result = await register(addresses);
          if (revision === revisionRef.current && result?.success === false) {
            console.warn(
              '[ReticulumChat] Failed to register authenticated DM address:',
              result.error || 'unknown error'
            );
          }
        })
        .catch((error) => {
          if (revision === revisionRef.current) {
            console.warn(
              '[ReticulumChat] Failed to register authenticated DM address:',
              error
            );
          }
        });
    },
    [register]
  );

  useEffect(() => {
    // Secondary Electron windows share the same main-process manager. They
    // must never clear or replace the primary window's account registration.
    if (!managed) return;
    queueRegistration(desiredAddressesRef.current);
  }, [address, authenticated, enabled, managed, queueRegistration]);

  useEffect(() => {
    if (!managed || typeof onReadinessChanged !== 'function') return;

    // A startup registration can race manager creation. Reapply the latest
    // authenticated state once readiness changes to ready. This is event
    // driven and bounded, so it adds no polling or overlay traffic.
    return onReadinessChanged((status) => {
      if (status.state === 'ready') {
        queueRegistration(desiredAddressesRef.current);
      }
    });
  }, [managed, onReadinessChanged, queueRegistration]);
};
