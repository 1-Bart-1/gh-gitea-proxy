/**
 * CI on a commit as GitHub models it: Gitea Actions jobs are check runs, and
 * only the statuses something else posted are commit statuses. Gitea writes a
 * status for every Actions job as well, which would otherwise count twice.
 */
import type { Gitea } from "./gitea.ts";
import type { GActionJob, GActionRun, GCombinedStatus, GStatus } from "./types.ts";

/** Whether a status is the one Gitea Actions wrote for a job. */
const fromActions = (status: GStatus): boolean => /\/actions\/runs\/\d+\/jobs\/\d+/.test(status.target_url);

/** The commit statuses on `sha` that Gitea Actions did not write. */
export async function statusesOn(gitea: Gitea, repo: string, sha: string): Promise<GStatus[]> {
  const combined = await gitea.get<GCombinedStatus>(`repos/${repo}/commits/${sha}/status`);
  return (combined.statuses ?? []).filter((status) => !fromActions(status));
}

/** Every Actions job of the latest attempt of each run on `sha`. */
export async function jobsOn(gitea: Gitea, repo: string, sha: string): Promise<GActionJob[]> {
  const runs = await gitea.get<{ workflow_runs: GActionRun[] | null }>(`repos/${repo}/actions/runs`,
    { head_sha: sha });
  const lists = await Promise.all((runs.workflow_runs ?? []).map((run) =>
    gitea.get<{ jobs: GActionJob[] | null }>(`repos/${repo}/actions/runs/${run.id}/jobs`)));
  return lists.flatMap((list) => list.jobs ?? []);
}

/**
 * GitHub's details URL of a job, `<repo>/actions/runs/<run>/job/<job>`, with
 * the API's IDs, so a client reading them out of it can fetch the log and
 * rerun the run.
 */
export const detailsUrl = (repoHtml: string, job: GActionJob): string =>
  `${repoHtml}/actions/runs/${job.run_id}/job/${job.id}`;

/** The state of a commit from the states of everything that ran on it, as GitHub combines them. */
export function combined(states: string[]): string {
  if (states.some((state) => ["failure", "error", "cancelled", "timed_out"].includes(state))) return "failure";
  if (states.some((state) => !["success", "skipped", "neutral"].includes(state))) return "pending";
  return "success";
}

/** A job's outcome as one commit-status-like state: its conclusion, or pending while it runs. */
export const jobState = (job: GActionJob): string =>
  job.status === "completed" ? job.conclusion || "neutral" : "pending";
