/** Release identity and commit retained independently of a moving branch or tag. */
export interface UpstreamRelease {
  repository: string;
  release_id: string;
  tag: string;
  revision: string;
  published_at: string;
  url: string;
}
export interface ProjectUpstreamOverview {
  repository: string | null;
  detected: UpstreamRelease | null;
  active: { implementation_id: string; release: UpstreamRelease } | null;
  candidate: UpstreamRelease | null;
}
