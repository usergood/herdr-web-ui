import { useEffect, useState } from "react";
import type { FactoryArtifact } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";

/** srcdoc adds its own policy so fetched previews and the browser demo share the same isolation. */
const HTML_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
export function FactoryArtifactPreview({ artifact }: { artifact: FactoryArtifact }) {
  const t = useT(); const [content, setContent] = useState<string | null>(null); const [error, setError] = useState(false);
  useEffect(() => {
    let live = true; let objectUrl: string | null = null;
    setContent(null); setError(false);
    void (async () => {
      try {
        const response = await fetch(`/api/factory/artifacts/${artifact.id}/preview`);
        if (!response.ok) throw new Error();
        if (artifact.media_type === "text/html") { const source = await response.text(); if (live) setContent(`<meta http-equiv="Content-Security-Policy" content="${HTML_POLICY.replaceAll('"', '&quot;')}">${source}`); }
        else { const blob = await response.blob(); if (!live) return; objectUrl = URL.createObjectURL(blob); setContent(objectUrl); }
      } catch { if (live) setError(true); }
    })();
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifact.id, artifact.hash, artifact.media_type]);
  if (error) return <p role="status">{t("Attachment unavailable")}</p>;
  if (content === null) return <p role="status">{t("Loading…")}</p>;
  return artifact.media_type === "text/html" ? <iframe title={artifact.name} sandbox="" referrerPolicy="no-referrer" srcDoc={content} /> : <img alt={artifact.name} src={content} />;
}
