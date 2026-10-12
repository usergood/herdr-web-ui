import { useEffect, useRef, useState } from "react";
import type { AccountOverview, AccountProfile, NativeAccountDiscovery } from "../../shared/accounts.ts";
import { accountRequest } from "../lib/accountsApi.ts";
import { useT } from "../lib/i18n.ts";

export function NativeAccountImport({ machineId, path, busy, perform, onImported }: { machineId: string; path?: string; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; onImported?: (profile: AccountProfile) => void }) {
  const t = useT(); const prefix = `/machines/${encodeURIComponent(machineId)}/accounts`; const route = prefix + "/discovery" + (path ? `?path=${encodeURIComponent(path)}` : "");
  const [data, setData] = useState<NativeAccountDiscovery | null>(null); const [accounts, setAccounts] = useState<AccountOverview | null>(null); const [problem, setProblem] = useState<string | null>(null); const epoch = useRef(0);
  useEffect(() => { const id = ++epoch.current; setData(null);setProblem(null); void Promise.all([accountRequest<NativeAccountDiscovery>(route),accountRequest<AccountOverview>(prefix)]).then(([sources,profiles])=>{if(id===epoch.current){setData(sources);setAccounts(profiles);}},error=>{if(id===epoch.current)setProblem(error.message);});return()=>{epoch.current++;};},[route]);
  return <section className="factory-section"><h3>{t("Saved GitHub logins")}</h3><p className="field-hint">{t("Reuse a login already configured on this Machine. Import keeps your global account selection unchanged.")}</p>
    {problem && <p role="alert">{problem}</p>}{!data && !problem && <p role="status">{t("Loading…")}</p>}
    {data && !data.sources.length && <p role="status">{t("No saved GitHub logins found. You can add a Machine account.")}</p>}
    {data?.sources.map(source=>{const existing=accounts?.profiles.find(p=>p.id===source.existing_profile_id);const ready=existing?.state==="ready";return <div className="factory-actions" key={source.id}><span>{source.login}</span>{ready&&<span role="status">{t("Ready")}</span>}{!source.available&&<span role="status">{t("Needs sign-in")}</span>}<button type="button" className="btn" disabled={busy||!source.available} onClick={()=>{const id=epoch.current;void perform(async()=>{const profile=await accountRequest<AccountProfile>(prefix+"/import",{source_id:source.id,...(path?{path}:{})});if(id!==epoch.current)return;const [nextAccounts,nextSources]=await Promise.all([accountRequest<AccountOverview>(prefix),accountRequest<NativeAccountDiscovery>(route)]);if(id!==epoch.current)return;setAccounts(nextAccounts);setData(nextSources);onImported?.(profile);});}}>{t("Import {login}",{login:source.login})}</button></div>;})}
  </section>;
}
