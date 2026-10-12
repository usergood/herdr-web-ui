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
    const id = ++request.current; setCapabilities(null); setProblem(null);
    if (!implementationId) return;
    void factoryRequest<FactoryCapabilities>(`/providers?machine_id=${encodeURIComponent(machineId)}&implementation_id=${encodeURIComponent(implementationId)}`).then(value => {
      if (id === request.current && scope.current === key) setCapabilities(value);
    }, error => { if (id === request.current && scope.current === key) setProblem(error.detail ?? error.message); });
    return () => { request.current++; };
  }, [key]);
  return { capabilities, problem, apply };
}
