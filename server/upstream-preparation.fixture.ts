/** Explicit owner inputs for an owned release fixture, submitted only through HTTP. */
export async function approveUpstreamPreparation(request: (path: string, body?: unknown) => Promise<Response>, prefix: string) {
  const specification = await request(prefix + "/specifications", { content: "Prepare only the detected upstream release in this Assignment's isolated workspace. Retain the diff, configured checks and independent Standards and Spec reviews. Ask the owner about conflicts, missing prerequisites or new decisions. Publication follows the separate Project policy; merge, release and deployment remain manual." }).then(r => r.json());
  for (const kind of ["specification", "testing_seams"]) {
    if (!(await request(prefix + "/approvals", { kind, revision: specification.id, scope: "Owned fixture approval: public HTTP/API, owned native operations and real browser journeys" })).ok) throw new Error("Owned upstream approval failed");
  }
  const graph = await request(prefix + "/tickets", { specification_id: specification.id, tickets: [{ key: "prepare", title: "Prepare the accepted upstream release", acceptance: "Keep the release fixed, work isolated and checks/reviews current; retain conflicts for owner input.", dependencies: [] }] }).then(r => r.json());
  if (!(await request(prefix + "/approvals", { kind: "ticket_graph", revision: graph.hash, scope: "One bounded owned upstream Ticket" })).ok) throw new Error("Owned upstream Ticket approval failed");
  return { specification, graph };
}
