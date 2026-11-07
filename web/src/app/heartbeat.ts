// Heartbeat sender, isolated so an offline/queued/SMS sender can replace it later without touching the UI.
// Sends one ping immediately when enabled, then every HEARTBEAT_INTERVAL_SEC.
import { useEffect, useRef, useState } from 'react';
import { HEARTBEAT_INTERVAL_SEC } from '../../../module/src/logic';
import type { Api } from '../stdb/types';

export interface HeartbeatState {
  lastSent?: Date;
  nextAt?: Date;
  accuracy?: number;
  error?: string;
  sending: boolean;
}

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number;
}

function currentPosition(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('This browser has no geolocation.'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      err =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? 'Location permission denied. Allow location for this site, or use the demo location.'
              : err.code === err.TIMEOUT
                ? 'Location timed out. Will retry on the next heartbeat.'
                : 'Location unavailable. Will retry on the next heartbeat.'
          )
        ),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 30_000 }
    );
  });
}

export function useHeartbeat(api: Api, enabled: boolean, demoFix: Fix | null) {
  const [state, setState] = useState<HeartbeatState>({ sending: false });
  const demoRef = useRef(demoFix);
  demoRef.current = demoFix;
  const sendRef = useRef<() => Promise<void>>(async () => {});

  sendRef.current = async () => {
    setState(s => ({ ...s, sending: true }));
    try {
      const fix = demoRef.current ?? (await currentPosition());
      await api.ping(fix);
      setState({ sending: false, lastSent: new Date(), nextAt: new Date(Date.now() + HEARTBEAT_INTERVAL_SEC * 1000), accuracy: fix.accuracy });
    } catch (e) {
      setState(s => ({ ...s, sending: false, error: e instanceof Error ? e.message : String(e), nextAt: new Date(Date.now() + HEARTBEAT_INTERVAL_SEC * 1000) }));
    }
  };

  useEffect(() => {
    if (!enabled) {
      setState({ sending: false });
      return;
    }
    void sendRef.current();
    const id = window.setInterval(() => void sendRef.current(), HEARTBEAT_INTERVAL_SEC * 1000);
    return () => window.clearInterval(id);
  }, [enabled]);

  return { state, sendNow: () => sendRef.current() };
}
