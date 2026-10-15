import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { admin, commitFile, freshRepo, type Harness, harness, numberIn } from "./harness.ts";

let h: Harness;
let repo: string;

before(async () => {
  h = await harness();
  repo = await freshRepo("pulls");
  h.ok(["label", "create", "rules", "--repo", repo, "--color", "0E8A16", "--force", "--description", "r"]);
});

after(() => h.close());

/** A pull request from a fresh branch carrying one new file. */
async function openPull(branch: string, extra: string[] = []): Promise<number> {
  await commitFile(repo, branch, `${branch}.txt`, `content of ${branch}\n`);
  return numberIn(h.ok(["pr", "create", "--repo", repo, "--head", branch, "--base", "main",
    "--title", `Change ${branch}`, "--body", `Body of ${branch}`, ...extra]));
}

describe("gh subcommands", () => {
  test("gh pr create --draft --label", async () => {
    const number = await openPull("drafted", ["--draft", "--label", "rules"]);
    const pull = await admin("GET", `repos/${repo}/pulls/${number}`);
    assert.equal(pull.draft, true);
    assert.equal(pull.head.ref, "drafted");
    assert.deepEqual(pull.labels.map((label: any) => label.name), ["rules"]);
    const view = h.json(["pr", "view", String(number), "--repo", repo, "--json", "title,isDraft"]);
    assert.deepEqual(view, { title: "Change drafted", isDraft: true });
  });

  test("gh pr ready", async () => {
    const number = await openPull("readied", ["--draft"]);
    h.ok(["pr", "ready", String(number), "--repo", repo]);
    assert.equal((await admin("GET", `repos/${repo}/pulls/${number}`)).draft, false);
    h.ok(["pr", "ready", String(number), "--repo", repo, "--undo"]);
    const pull = await admin("GET", `repos/${repo}/pulls/${number}`);
    assert.equal(pull.draft, true);
    assert.match(pull.title, /Change readied$/);
  });

  test("gh pr edit", async () => {
    const number = await openPull("edited", ["--draft"]);
    h.ok(["pr", "edit", String(number), "--repo", repo, "--title", "Renamed", "--body", "New body"]);
    const view = h.json(["pr", "view", String(number), "--repo", repo, "--json", "title,body,isDraft"]);
    assert.deepEqual(view, { title: "Renamed", body: "New body", isDraft: true });
  });

  test("gh pr view --json", async () => {
    const number = await openPull("viewed");
    const view = h.json(["pr", "view", String(number), "--repo", repo, "--json",
      "headRefName,state,mergeCommit,body"]);
    assert.deepEqual(view, { headRefName: "viewed", state: "OPEN", mergeCommit: null, body: "Body of viewed" });
    assert.equal(h.ok(["pr", "view", String(number), "--repo", repo, "--json", "body", "--jq", ".body"]).trim(),
      "Body of viewed");
  });

  test("gh pr diff", async () => {
    const number = await openPull("diffed");
    const diff = h.ok(["pr", "diff", String(number), "--repo", repo]);
    assert.match(diff, /^diff --git a\/diffed.txt b\/diffed.txt/m);
    assert.match(diff, /^\+content of diffed$/m);
  });

  test("gh pr list", async () => {
    const number = await openPull("listed");
    const fields = "number,title,body,author,createdAt,isDraft,statusCheckRollup,latestReviews";
    const open = h.json(["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", fields]);
    const listed = open.find((pull: any) => pull.number === number);
    assert.equal(listed.title, "Change listed");
    assert.equal(listed.author.login, h.login);
    assert.equal(listed.isDraft, false);
    assert.deepEqual(listed.statusCheckRollup, []);
    assert.deepEqual(listed.latestReviews, []);

    const byHead = h.ok(["pr", "list", "--repo", repo, "--head", "listed", "--state", "open",
      "--json", "number", "--jq", ".[0].number // empty"]);
    assert.equal(Number(byHead), number);
  });

  test("gh pr list --state all after a merge", async () => {
    const number = await openPull("merged");
    await admin("POST", `repos/${repo}/pulls/${number}/merge`, { Do: "merge" });
    const [pull] = h.json(["pr", "list", "--repo", repo, "--head", "merged", "--state", "all",
      "--limit", "1", "--json", "number,state,mergeCommit"]);
    assert.equal(pull.number, number);
    assert.equal(pull.state, "MERGED");
    assert.match(pull.mergeCommit.oid, /^[0-9a-f]{40}$/);
  });
});
