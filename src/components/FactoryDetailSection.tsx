import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FactoryDetail } from "../../shared/factory.ts";
import { factoryRead } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";

/** Retained evidence is read only while expanded, once per server revision. */
export function FactoryDetailSection<T = FactoryDetail>({ id, revision, title, children, view }: { view?: "review"; id: string; revision: string; title: string; children: (detail: T) => ReactNode }) {
  const t = useT(), [open, setOpen] = useState(false), [detail, setDetail] = useState<T | null>(null), [error, setError] = useState<string | null>(null);
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (!open || loaded.current === `${id}:${revision}`) return;
    let live = true; setError(null);
    void factoryRead<T>(`/implementations/${id}${view ? "?view=" + view : ""}`).then(next => { if (live) { loaded.current = `${id}:${revision}`; setDetail(next); } }).catch(failure => { if (live) setError(failure.message); });
    return () => { live = false; };
  }, [id, revision, open, view]);
  return <details className="factory-section" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}><summary>{title}</summary>{open && error && <p role="alert">{error}</p>}{detail ? children(detail) : open && !error ? <p role="status">{t("Loading…")}</p> : null}</details>;
}
