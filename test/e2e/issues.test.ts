import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { admin, freshRepo, type Harness, harness, numberIn } from "./harness.ts";

let h: Harness;
let repo: string;

before(async () => {
  h = await harness();
  repo = await freshRepo("issues");
});

after(() => h.close());

const bodyFile = (text: string): string => {
  const path = join(tmpdir(), `gh-gitea-proxy-body-${process.pid}-${Math.random()}`);
  writeFileSync(path, text);
  return path;
};

describe("gh subcommands", () => {
  test("gh label create --force", async () => {
    h.ok(["label", "create", "agent-task", "--repo", repo, "--color", "5319E7", "--force",
      "--description", "queued for the box"]);
    h.ok(["label", "create", "agent-task", "--repo", repo, "--color", "112233", "--force",
      "--description", "updated"]);
    const labels = await admin<any[]>("GET", `repos/${repo}/labels`);
    const label = labels.find((entry) => entry.name === "agent-task");
    assert.equal(label.color.replace("#", ""), "112233");
    assert.equal(label.description, "updated");
  });

  test("gh issue create", async () => {
    h.ok(["label", "create", "priority", "--repo", repo, "--color", "B60205", "--force",
      "--description", "p"]);
    const printed = h.ok(["issue", "create", "--repo", repo, "--assignee", h.login,
      "--label", "agent-task", "--label", "priority", "--title", "A task", "--body", "Do it"]);
    const issue = await admin("GET", `repos/${repo}/issues/${numberIn(printed)}`);
    assert.equal(issue.title, "A task");
    assert.equal(issue.body, "Do it");
    assert.deepEqual(issue.labels.map((label: any) => label.name).sort(), ["agent-task", "priority"]);
    assert.deepEqual(issue.assignees.map((user: any) => user.login), [h.login]);

    const fromFile = h.ok(["issue", "create", "--repo", repo, "--title", "From a file",
      "--body-file", bodyFile("Body from a file")]);
    assert.equal((await admin("GET", `repos/${repo}/issues/${numberIn(fromFile)}`)).body,
      "Body from a file");
  });

  test("gh issue edit", async () => {
    const number = numberIn(h.ok(["issue", "create", "--repo", repo, "--title", "Old", "--body", "x"]));
    h.ok(["issue", "edit", String(number), "--repo", repo, "--add-label", "agent-task",
      "--title", "New", "--body-file", bodyFile("New body")]);
    const issue = await admin("GET", `repos/${repo}/issues/${number}`);
    assert.equal(issue.title, "New");
    assert.equal(issue.body, "New body");
    assert.deepEqual(issue.labels.map((label: any) => label.name), ["agent-task"]);
  });

  test("gh issue comment", async () => {
    const number = numberIn(h.ok(["issue", "create", "--repo", repo, "--title", "Talk", "--body", "x"]));
    h.ok(["issue", "comment", String(number), "--repo", repo, "--body-file", bodyFile("Hello")]);
    const comments = await admin<any[]>("GET", `repos/${repo}/issues/${number}/comments`);
    assert.deepEqual(comments.map((comment) => comment.body), ["Hello"]);
  });

  test("gh issue close --reason --comment", async () => {
    const number = numberIn(h.ok(["issue", "create", "--repo", repo, "--title", "Done", "--body", "x"]));
    h.ok(["issue", "close", String(number), "--repo", repo, "--reason", "completed",
      "--comment", "All merged."]);
    const issue = await admin("GET", `repos/${repo}/issues/${number}`);
    assert.equal(issue.state, "closed");
    const comments = await admin<any[]>("GET", `repos/${repo}/issues/${number}/comments`);
    assert.deepEqual(comments.map((comment) => comment.body), ["All merged."]);

    const other = numberIn(h.ok(["issue", "create", "--repo", repo, "--title", "Never", "--body", "x"]));
    h.ok(["issue", "close", String(other), "--repo", repo, "--reason", "not planned"]);
    assert.equal((await admin("GET", `repos/${repo}/issues/${other}`)).state, "closed");
  });

  test("gh issue list", () => {
    h.ok(["issue", "create", "--repo", repo, "--title", "Listed", "--body", "listed body",
      "--label", "priority"]);
    const labelled = h.json(["issue", "list", "--repo", repo, "--state", "open", "--label", "priority",
      "--json", "number"]);
    assert.ok(labelled.length >= 1);
    assert.ok(labelled.every((issue: any) => typeof issue.number === "number"));

    const mine = h.json(["issue", "list", "--repo", repo, "--author", h.login, "--state", "all",
      "--limit", "100", "--json", "number,body"]);
    assert.ok(mine.some((issue: any) => issue.body === "listed body"));

    const jq = h.ok(["issue", "list", "--repo", repo, "--state", "all", "--json", "number",
      "--jq", ".[] | @json"]);
    assert.ok(jq.trim().split("\n").every((line) => typeof JSON.parse(line).number === "number"));
  });

  test("gh issue view", () => {
    const number = numberIn(h.ok(["issue", "create", "--repo", repo, "--title", "Viewed",
      "--body", "seen"]));
    const printed = h.ok(["issue", "view", String(number), "--repo", repo]);
    assert.match(printed, /Viewed/);
    assert.match(printed, /seen/);
    const json = h.json(["issue", "view", String(number), "--repo", repo, "--json",
      "title,body,state,labels,author,comments"]);
    assert.equal(json.title, "Viewed");
    assert.equal(json.state, "OPEN");
    assert.equal(json.author.login, h.login);
  });
});
