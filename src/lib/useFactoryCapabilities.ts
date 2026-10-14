import { useCallback, useEffect, useRef, useState } from "react";
import type { FactoryCapabilities } from "../../shared/protocol.ts";
import { factoryRequest } from "./factoryApi.ts";

/** One Assignment scope owns capability reads and verification updates for both views. */
export function useFactoryCapabilities(machineId: string, implementationId: string | null, accountScope: string) {
  const key = JSON.stringify([machineId, implementationId, accountScope]);
  const scope = useRef(key); scope.current = key;
  const request = useRef(0);
  const [capabilities, setCapabilities] = useState<FactoryCapabilities | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const apply = useCallback((value: FactoryCapabilities) => {
    if (scope.current !== key) return;
    request.current++; setCapabilities(value); setProblem(null);
  }, [key]);
  useEffect(() => {
    let live = true; let timer: ReturnType<typeof setTimeout>;
    setCapabilities(null); setProblem(null);
    if (!implementationId) return;
    const read = async () => {
      const id = ++request.current;
      try {
        if (document.visibilityState === "visible") {
          const value = await factoryRequest<FactoryCapabilities>(`/providers?machine_id=${encodeURIComponent(machineId)}&implementation_id=${encodeURIComponent(implementationId)}`);
          if (live && id === request.current && scope.current === key) { setCapabilities(value); setProblem(null); }
        }
      } catch (error) { if (live && id === request.current && scope.current === key) setProblem(error instanceof Error ? error.message : String(error)); }
      finally { if (live) { clearTimeout(timer); timer = setTimeout(() => void read(), 10000); } }
    };
    const changed = () => { clearTimeout(timer); void read(); };
    void read(); window.addEventListener("factory-changed", changed); document.addEventListener("visibilitychange", changed);
    return () => { live = false; request.current++; clearTimeout(timer); window.removeEventListener("factory-changed", changed); document.removeEventListener("visibilitychange", changed); };
  }, [key]);
  return { capabilities, problem, apply };
}
