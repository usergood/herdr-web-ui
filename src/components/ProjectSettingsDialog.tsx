import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Folder, GitPullRequest, KeyRound, Library, Settings, Workflow, X, type LucideIcon } from "lucide-react";
import type { FactoryOverview } from "../../shared/factory.ts";
import type { Machine } from "../../shared/machines.ts";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { ProjectsPanel, type ProjectSettingsPage } from "./ProjectsPanel.tsx";
import "./SettingsDialog.css";

export function ProjectSettingsDialog({ overview, machines, projectId, refresh, onProject, onClose }: { overview: FactoryOverview | null; machines: Machine[]; projectId: string | null; refresh: () => Promise<void>; onProject: (id: string | null) => void; onClose: () => void }) {
  const t = useT(); const narrow = useMediaQuery("(max-width: 640px)"); const panelId = useId();
  const [chosen, setChosen] = useState<ProjectSettingsPage | null>(null);
  const surface = useFocusTrap<HTMLElement>(true); const tabs = useRef<HTMLDivElement>(null);
  useSheetSwipe(surface, onClose); usePhoneSheetBack(onClose);
  const pages: { id: ProjectSettingsPage; label: string; icon: LucideIcon }[] = projectId ? [
    { id: "general", label: t("Project"), icon: Folder }, { id: "execution", label: t("Workflow"), icon: Workflow },
    { id: "checkout", label: t("Checkout path"), icon: Folder }, { id: "accounts", label: t("Accounts"), icon: KeyRound },
    { id: "references", label: t("Project references"), icon: Library }, { id: "github", label: "GitHub", icon: GitPullRequest },
  ] : [{ id: "general", label: t("Projects"), icon: Folder }, { id: "factory", label: t("Factory"), icon: Settings }];
  const page = chosen && pages.some((p) => p.id === chosen) ? chosen : narrow ? null : pages[0]!.id;
  const label = pages.find((p) => p.id === page)?.label;
  const title = projectId ? overview?.projects.find((p) => p.id === projectId)?.name ?? t("Project") : t("Projects");
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || nativeModalOver(surface.current)) return; event.preventDefault(); event.stopPropagation(); onClose(); };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  return <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={surface} className="modal settings-dialog" role="dialog" aria-modal="true" aria-label={projectId ? t("Project settings") : t("Projects")} tabIndex={-1}>
      <header className="modal-header settings-header">{narrow && page && <button className="icon-button" aria-label={t("Back to settings")} onClick={() => setChosen(null)}><ArrowLeft /></button>}<h2 className="modal-title">{title}{label && ` · ${label}`}</h2><button className="icon-button" aria-label={t("Close settings")} onClick={onClose}><X /></button></header>
      {(!narrow || !page) && <nav className="settings-nav" aria-label={t("Project settings")}><p className="settings-nav-title">{title}</p><div ref={tabs} className="settings-tabs" role="tablist" aria-orientation="vertical">
        {pages.map(({ id, label: name, icon: Icon }, index) => <button key={id} className="settings-tab" role="tab" aria-selected={page === id} aria-controls={page === id ? panelId : undefined} tabIndex={(page ?? pages[0]!.id) === id ? 0 : -1} onClick={() => setChosen(id)} onKeyDown={(event) => {
          const to = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? pages.length - 1 : null;
          if (to === null) return; event.preventDefault(); const next = (to + pages.length) % pages.length;
          tabs.current?.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus(); if (!narrow) setChosen(pages[next]!.id);
        }}><Icon aria-hidden="true" /><span>{name}</span><ChevronRight className="settings-tab-chevron" aria-hidden="true" /></button>)}
      </div></nav>}
      {page && <div id={panelId} className="modal-body settings-body" role="tabpanel" aria-label={label}><ProjectsPanel key={projectId ?? "all"} section={page} embedded overview={overview} machines={machines} projectId={projectId} refresh={refresh} onProject={onProject} /></div>}
    </section>
  </div>;
}
