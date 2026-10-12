import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { MachineContext } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import "./ProjectFolderPicker.css";

export function ProjectFolderPicker({ machineId, value, onPick, disabled = false }: { machineId: string; value: string; onPick: (path: string) => void; disabled?: boolean }) {
  const t = useT(); const [open, setOpen] = useState(false);
  return <div className="project-folder-field"><label className="field-label">{t("Checkout path")}</label>
    <button type="button" className="input project-folder-control" aria-label={t("Checkout path")} aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}><span>{value || t("Choose a repository folder")}</span><FolderOpen aria-hidden="true" /></button>
    {open && <MachineContext.Provider value={machineId}><DirectoryBrowser key={machineId} start={value} absolute onPick={(path) => { setOpen(false); onPick(path); }} /></MachineContext.Provider>}
  </div>;
}
