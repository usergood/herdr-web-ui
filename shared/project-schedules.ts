export type ProjectSyncJob = "github_sync" | "upstream_sync";
export interface ProjectSyncSchedule {
  job: ProjectSyncJob;
  enabled: boolean;
  cadence: "interval" | "daily";
  interval_minutes: number;
  local_time: string;
  time_zone: string;
  revision: string | null;
  next_execution: string | null;
  condition: "idle" | "running" | "failed" | "uncertain";
  failure_count: number;
  retry_at: string | null;
}
export interface ProjectSyncResult {
  id: string;
  job: ProjectSyncJob;
  trigger: "manual" | "scheduled" | "reconcile";
  condition: "running" | "succeeded" | "failed" | "uncertain" | "reconciled";
  started_at: string;
  finished_at: string | null;
  problem: string | null;
}
export interface ProjectSchedulesOverview { schedules: ProjectSyncSchedule[]; results: ProjectSyncResult[] }
export type ProjectScheduleConfiguration = Pick<ProjectSyncSchedule, "job" | "enabled" | "cadence" | "interval_minutes" | "local_time" | "time_zone"> & { expected_revision: string | null };
