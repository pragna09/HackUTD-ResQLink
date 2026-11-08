import { useSyncExternalStore } from 'react';
import { createLiveBackend } from './live';
import { createMockBackend } from './mock';
import type { Api, Backend, LiveState } from './types';

const wantsMock = () => {
  try {
    return new URLSearchParams(location.search).get('mock') === '1' || import.meta.env.VITE_MOCK === '1';
  } catch {
    return false;
  }
};

let backend: Backend | undefined;
/** One connection per tab, shared by every page. */
export function getBackend(): Backend {
  backend ??= wantsMock() ? createMockBackend() : createLiveBackend();
  return backend;
}

export function useLive(): LiveState {
  const b = getBackend();
  return useSyncExternalStore(b.subscribe, b.getState);
}

export function useApi(): Api {
  return getBackend().api;
}
