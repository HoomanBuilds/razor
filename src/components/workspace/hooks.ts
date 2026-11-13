"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, RequestError } from "@/lib/api";

export function useResource<T>(path: string | null, revision: number) {
  const [snapshot, setSnapshot] = useState<{ path: string | null; data: T | null; error: string; loading: boolean; revision: number }>({ path: null, data: null, error: "", loading: false, revision });
  useEffect(() => {
    let current = true;
    if (!path) { setSnapshot({ path, data: null, error: "", loading: false, revision }); return; }
    const controller = new AbortController();
    setSnapshot(previous => ({ path, data: previous.path === path ? previous.data : null, error: "", loading: true, revision }));
    api<T>(path, undefined, undefined, { signal: controller.signal }).then(value => {
      if (current) setSnapshot({ path, data: value, error: "", loading: false, revision });
    }).catch(cause => {
      if (!current) return;
      const denied = cause instanceof RequestError && [401, 403].includes(cause.status);
      setSnapshot(previous => ({ path, data: !denied && previous.path === path ? previous.data : null, error: errorMessage(cause), loading: false, revision }));
    });
    return () => { current = false; controller.abort(); };
  }, [path, revision]);
  const samePath = !!path && snapshot.path === path;
  const data = samePath ? snapshot.data : null;
  return { data, error: samePath ? snapshot.error : "", loading: !!path && (!samePath || snapshot.loading && data === null), refreshing: !!path && (!samePath || snapshot.loading || snapshot.revision !== revision) };
}

export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const run = useCallback(async (key: string, task: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(key);
    setError("");
    try { await task(); } catch (cause) { setError(errorMessage(cause)); } finally { lock.current = false; setBusy(null); }
  }, []);
  return { busy, error, run, setError };
}
