import type { GActionJob, GActionRun, GRepo } from "../types.ts";
import { paged, route } from "./router.ts";

const R = "repos/:owner/:repo";
const repoName = (params: Record<string, string>) => `${params.owner}/${params.repo}`;

/**
 * A Gitea Actions job as a GitHub check run. The details URL takes GitHub's
 * `/actions/runs/<run>/job/<job>` form with the API's IDs, so a client that
 * reads them out of it can ask for the job's log and rerun its run.
 */
export const checkRun = (repo: GRepo, job: GActionJob) => ({
  id: job.id, name: job.name, head_sha: job.head_sha, status: job.status,
  conclusion: job.conclusion || null, started_at: job.started_at ?? null,
  completed_at: job.completed_at ?? null, html_url: job.html_url,
  details_url: `${repo.html_url}/actions/runs/${job.run_id}/job/${job.id}`,
});

/** Every Actions job that ran on `sha`. */
export async function jobsOn(gitea: import("../gitea.ts").Gitea, repo: string, sha: string) {
  const runs = await gitea.get<{ workflow_runs: GActionRun[] | null }>(`repos/${repo}/actions/runs`,
    { head_sha: sha, limit: 50 });
  const lists = await Promise.all((runs.workflow_runs ?? []).map((run) =>
    gitea.get<{ jobs: GActionJob[] | null }>(`repos/${repo}/actions/runs/${run.id}/jobs`)));
  return lists.flatMap((list) => list.jobs ?? []);
}

route("GET", `${R}/commits/:sha/check-runs`, async (request) => {
  const repo = repoName(request.params);
  const data = await request.gitea.get<GRepo>(`repos/${repo}`);
  const runs = (await jobsOn(request.gitea, repo, request.params.sha)).map((job) => checkRun(data, job));
  const page = paged(request, `repos/${repo}/commits/${request.params.sha}/check-runs`, runs);
  return { headers: page.headers, body: { total_count: runs.length, check_runs: page.body } };
});

route("GET", `${R}/actions/jobs/:job/logs`, async ({ gitea, params }) => {
  const response = await gitea.raw("GET", `repos/${repoName(params)}/actions/jobs/${params.job}/logs`,
    {}, undefined, "*/*");
  return { raw: await response.text() };
});

for (const verb of ["rerun", "rerun-failed-jobs", "cancel"]) {
  route("POST", `${R}/actions/runs/:run/${verb}`, async ({ gitea, params }) => {
    await gitea.call("POST", `repos/${repoName(params)}/actions/runs/${params.run}/${verb}`);
    return { status: 201, body: {} };
  });
}

route("POST", `${R}/actions/runners/registration-token`, async ({ gitea, params }) => {
  const created = await gitea.call<{ token: string }>("POST",
    `repos/${repoName(params)}/actions/runners/registration-token`);
  return { status: 201, body: { token: created.token, expires_at: null } };
});
