/** Drop-in renderings of the two dapp-side pieces: the ui widgets, mounted.
 *
 *  A dapp wanting its own look should use the hooks and render freely. */

import { useEffect, useRef } from 'react';
import {
  mountRelaySettings,
  mountSessionCode,
  type RelaySettingsHandle,
} from '@verumlab/connect-ui';
import { useVerumProvider } from './hooks.js';

/** The session code, for comparing against the hub's screen. Empty until a
 *  channel exists, so it can stay in the tree. */
export function VerumSessionCode({ label = 'Session' }: { label?: string }) {
  const provider = useVerumProvider();
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!provider || !host.current) return;
    const mounted = mountSessionCode(provider, { label });
    host.current.append(mounted.el);
    return () => mounted.destroy();
  }, [provider, label]);

  return <div ref={host} />;
}

export interface VerumRelaySettingsProps {
  /** True while a pairing code is on screen. See useVerumRelays. */
  locked?: boolean;
  /** Not drawn at all: a live session's relays cannot change without stranding it. */
  hidden?: boolean;
  title?: string;
}

export function VerumRelaySettings({
  locked = false,
  hidden = false,
  title = 'Verum Connect',
}: VerumRelaySettingsProps) {
  const provider = useVerumProvider();
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<RelaySettingsHandle | null>(null);

  useEffect(() => {
    if (!provider || !host.current || hidden) return;
    const mounted = mountRelaySettings(provider, { title });
    handle.current = mounted;
    host.current.append(mounted.el);
    return () => {
      mounted.destroy();
      handle.current = null;
    };
  }, [provider, hidden, title]);

  useEffect(() => {
    handle.current?.setLocked(locked);
  }, [locked, provider, hidden, title]);

  return <div ref={host} />;
}
