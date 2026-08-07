import { useEffect, useState } from 'react';

/**
 * Keeps a portal attached when its host is conditionally mounted or replaced.
 *
 * The authenticated shell can remount the global navbar while call providers
 * remain mounted. A one-time element lookup would leave the portal rendering
 * into the navbar node that was removed from the document.
 */
export function useLivePortalTarget(elementId: string): HTMLElement | null {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let currentTarget: HTMLElement | null = null;

    const refreshTarget = () => {
      const nextTarget = document.getElementById(elementId);
      if (nextTarget === currentTarget) return;
      currentTarget = nextTarget;
      setTarget(nextTarget);
    };

    refreshTarget();

    const observer = new MutationObserver(() => {
      // Most app mutations do not affect the navbar. Avoid a document lookup
      // unless the current host disappeared (or has not mounted yet).
      if (!currentTarget?.isConnected) refreshTarget();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      currentTarget = null;
    };
  }, [elementId]);

  return target;
}
