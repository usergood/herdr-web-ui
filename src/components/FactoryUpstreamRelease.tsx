import type { UpstreamRelease } from "../../shared/upstream-releases.ts";
import { useT } from "../lib/i18n.ts";

export function FactoryUpstreamRelease({ release }: { release?: UpstreamRelease }) {
  const t = useT();
  if (!release) return null;
  return <section className="factory-message" aria-label={t("Upstream release")}>
    <h4>{t("Upstream release")}</h4>
    <a href={release.url} target="_blank" rel="noreferrer">{release.repository} · {release.tag}</a>
    <p className="factory-context"><code>{release.revision}</code></p>
  </section>;
}
