"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";

export function useResource<T>(path: string | null, revision: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    if (!path) { setData(null); setLoading(false); setError(""); return; }
    setLoading(true);
    setData(null);
    setError("");
    api<T>(path).then((value) => { if (current) setData(value); }).catch((cause) => { if (current) setError(errorMessage(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [path, revision]);
  return { data, error, loading };
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
