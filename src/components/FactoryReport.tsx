import { useEffect, useState, useRef } from "react";
import { factoryRead } from "../lib/factoryApi.ts";
import type { FactoryReviewEvidence } from "../../shared/factory.ts";
import { useT } from "../lib/i18n.ts";

/** The enclosing native details element is the owner's request to read this immutable report. */
export function FactoryReport({ assignmentId, reportId }: { assignmentId: string; reportId: string }) {
  const ref = useRef<HTMLDivElement>(null), t = useT();
  const [content, setContent] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const details = ref.current?.closest("details"); let live = true, requested = false;
    setContent(null); setError(null);
    const load = () => {
      if (!details?.open || requested) return; requested = true; setError(null);
      void factoryRead<FactoryReviewEvidence>(`/implementations/${assignmentId}?view=report&record_id=${reportId}`).then(report => { if (live) setContent(report.content); }).catch(failure => { if (live) { setError(failure.message); requested = false; } });
    };
    details?.addEventListener("toggle", load); load();
    return () => { live = false; details?.removeEventListener("toggle", load); };
  }, [assignmentId, reportId]);
  return <div ref={ref}>{error ? <p role="alert">{error}</p> : content === null ? <p role="status">{t("Loading…")}</p> : <pre>{content}</pre>}</div>;
}
