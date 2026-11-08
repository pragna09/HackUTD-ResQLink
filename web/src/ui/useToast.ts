import { useCallback, useRef, useState } from 'react';

export function useToast() {
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((text: string, bad = false) => {
    window.clearTimeout(timer.current);
    setMsg({ text, bad });
    timer.current = window.setTimeout(() => setMsg(null), 3500);
  }, []);
  return { msg, show };
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
