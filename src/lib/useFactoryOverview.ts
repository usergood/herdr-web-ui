import { useCallback, useEffect, useRef, useState } from "react";
import type { FactoryOverview } from "../../shared/factory.ts";
import { factoryOverview } from "./factoryApi.ts";

export function useFactoryOverview(enabled: boolean) {
  const [overview, setOverview] = useState<FactoryOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const current = ++generation.current;
    try { const next = await factoryOverview(); if (current === generation.current) { setOverview(next); setError(null); } }
    catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : String(failure)); }
  }, [enabled]);
  useEffect(() => {
    if (!enabled) { generation.current++; setOverview(null); return; }
    let live = true; let timer: ReturnType<typeof setTimeout>;
    const read = async () => { if (document.visibilityState === "visible") await refresh(); if (live) timer = setTimeout(() => void read(), 5000); };
    const changed = () => void refresh();
    void read(); window.addEventListener("factory-changed", changed); document.addEventListener("visibilitychange", changed);
    return () => { live = false; generation.current++; clearTimeout(timer); window.removeEventListener("factory-changed", changed); document.removeEventListener("visibilitychange", changed); };
  }, [enabled, refresh]);
  return { overview, error, refresh };
}
