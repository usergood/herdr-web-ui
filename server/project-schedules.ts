import type { ProjectSyncSchedule } from "../shared/project-schedules.ts";
import { FactoryError } from "./factory-host.ts";

/** Optional deterministic clock/ticks supplied only through createServer(options). */
export interface ProjectScheduleTiming {
  now?: () => number;
  subscribe?: (poll: () => Promise<void>) => () => void;
}
export interface StoredProjectSchedule extends ProjectSyncSchedule { id: string; project_id: string }

export function validateProjectSchedule(value: unknown): asserts value is import("../shared/project-schedules.ts").ProjectScheduleConfiguration {
  const v = value as import("../shared/project-schedules.ts").ProjectScheduleConfiguration;
  if (!v || !["github_sync", "upstream_sync"].includes(v.job) || typeof v.enabled !== "boolean" || !["interval", "daily"].includes(v.cadence) || !Number.isInteger(v.interval_minutes) || v.interval_minutes < 5 || v.interval_minutes > 1440 || typeof v.local_time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.local_time) || typeof v.time_zone !== "string" || v.time_zone.length > 100 || v.expected_revision !== null && typeof v.expected_revision !== "string") throw new FactoryError("invalid_schedule", "Select a built-in job, bounded interval, local time and time zone");
  try { new Intl.DateTimeFormat("en", { timeZone: v.time_zone }); }
  catch { throw new FactoryError("invalid_schedule", "Select a valid IANA time zone"); }
}

/** Daily wall time occurs once per local date, including a repeated DST hour. */
export function nextProjectSync(schedule: ProjectSyncSchedule, now: number): string | null {
  if (!schedule.enabled) return null;
  if (schedule.cadence === "interval") return new Date(now + schedule.interval_minutes * 60_000).toISOString();
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.time_zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const local = (time: number) => {
    const parts = format.formatToParts(time);
    const part = (name: string) => parts.find(p => p.type === name)!.value;
    return { day: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
  };
  const current = local(now);
  // A skipped local time has no occurrence that day; use the next local date with one.
  for (let time = Math.floor(now / 60_000) * 60_000 + 60_000, end = now + 3 * 86400_000; time <= end; time += 60_000) {
    const candidate = local(time);
    if (candidate.time === schedule.local_time && (current.time < schedule.local_time || candidate.day !== current.day)) return new Date(time).toISOString();
  }
  throw new FactoryError("invalid_schedule", "The selected daily time has no upcoming occurrence");
}
