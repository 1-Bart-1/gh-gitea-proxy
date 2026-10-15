/**
 * CI as the Agents box watches it, from a real Gitea Actions run: a workflow
 * with one passing and one failing job on a host-mode runner from
 * `GITEA_RUNNER=1 test/e2e/gitea.sh`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { admin, commitFile, freshRepo, type Harness, harness } from "./harness.ts";

const WORKFLOW = `on: [push]
jobs:
  pass:
    runs-on: self-hosted
    steps:
      - run: echo fine
  fail:
    runs-on: self-hosted
    steps:
      - run: echo boom; exit 1
`;

let h: Harness;
let repo: string;
let sha: string;

/** Wait until every run on `sha` has finished. */
async function settled(): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt++) {
    const runs = await admin("GET", `repos/${repo}/actions/runs?head_sha=${sha}`);
    if (runs.workflow_runs?.length && runs.workflow_runs.every((run: any) => run.status === "completed")) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("the workflow never finished");
}

const skip = !process.env.E2E_RUNNER && "needs a runner: GITEA_RUNNER=1 test/e2e/gitea.sh, E2E_RUNNER=1";

describe("Gitea Actions", { skip }, () => {
  before(async () => {
    h = await harness();
    repo = await freshRepo("actions");
    sha = (await commitFile(repo, "main", ".gitea/workflows/ci.yml", WORKFLOW)).commit.sha;
    await settled();
  });

  after(() => h.close());

  test("GET repos/R/commits/SHA/check-runs from Gitea Actions", () => {
    const runs = h.ok(["api", `repos/${repo}/commits/${sha}/check-runs`, "-X", "GET", "-f", "per_page=100",
      "--jq", ".check_runs[] | {name, status, conclusion, detailsUrl: .details_url} | @json"])
      .trim().split("\n").map((line) => JSON.parse(line));
    const byName = Object.fromEntries(runs.map((run) => [run.name, run]));
    assert.equal(byName.pass.conclusion, "success");
    assert.equal(byName.fail.conclusion, "failure");
    assert.match(byName.fail.detailsUrl, /\/actions\/runs\/\d+\/job\/\d+$/);
    assert.deepEqual(h.json(["api", `repos/${repo}/commits/${sha}/status`]).statuses, []);
  });

  test("statusCheckRollup from Gitea Actions", () => {
    const [owner, name] = repo.split("/");
    const query = `query { repository(owner: "${owner}", name: "${name}") { ref(qualifiedName: "refs/heads/main") {
      target { ... on Commit { statusCheckRollup { state contexts(first: 100) { nodes {
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl } } } } } } } } }`;
    const rollup = h.json(["api", "graphql", "-f", `query=${query}`]).data.repository.ref.target.statusCheckRollup;
    assert.equal(rollup.state, "FAILURE");
    const failed = rollup.contexts.nodes.find((node: any) => node.name === "fail");
    assert.equal(failed.status, "COMPLETED");
    assert.equal(failed.conclusion, "FAILURE");
    assert.equal(rollup.contexts.nodes.length, 2);
  });

  test("GET repos/R/actions/jobs/N/logs", () => {
    const runs = h.json(["api", `repos/${repo}/commits/${sha}/check-runs`]).check_runs;
    const failed = runs.find((run: any) => run.name === "fail");
    const [, job] = /\/job\/(\d+)$/.exec(failed.details_url)!;
    assert.match(h.ok(["api", `repos/${repo}/actions/jobs/${job}/logs`]), /boom/);
  });

  test("POST repos/R/actions/runs/N/rerun-failed-jobs", async () => {
    const runs = h.json(["api", `repos/${repo}/commits/${sha}/check-runs`]).check_runs;
    const failed = runs.find((run: any) => run.name === "fail");
    const [, run] = /\/actions\/runs\/(\d+)\//.exec(failed.details_url)!;
    h.ok(["api", "-X", "POST", `repos/${repo}/actions/runs/${run}/rerun-failed-jobs`]);
    await settled();
    const again = h.json(["api", `repos/${repo}/commits/${sha}/check-runs`]).check_runs;
    assert.equal(again.find((entry: any) => entry.name === "fail").conclusion, "failure");
  });
});
