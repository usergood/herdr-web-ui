/** Connection-server queue controls; a view never dispatches native work. */
export interface ProjectQueueConfiguration {
  expected_revision: string | null; paused: boolean;
}
export interface ProjectQueueOverview {
  project_id: string; revision: string | null; paused: boolean; next_implementation_id: string | null;
  capacity: { project_implementations: number; implementations: number; agents: number; builds: number; max_agents: number; max_builds: number };
  items: { implementation_id: string; title: string; priority: number; eligible: boolean; reasons: string[]; failed_run_id: string | null; /** Retained admission diagnostic; absent on older servers. */ problem?: string | null }[];
}
