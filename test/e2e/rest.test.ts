import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { admin, commitFile, freshRepo, type Harness, harness, otherUser } from "./harness.ts";

let h: Harness;
let repo: string;
let issue: number;
let pull: number;
let sha: string;

/** jq output of one value per line, parsed. */
const lines = (out: string): any[] => out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

const input = (value: unknown): string => {
  const path = join(tmpdir(), `gh-gitea-proxy-input-${process.pid}-${Math.random()}`);
  writeFileSync(path, JSON.stringify(value));
  return path;
};

before(async () => {
  h = await harness();
  repo = await freshRepo("rest");
  await admin("POST", `repos/${repo}/labels`, { name: "agent-task", color: "#5319e7" });
  await admin("POST", `repos/${repo}/labels`, { name: "refresh", color: "#fbca04" });
  issue = (await admin("POST", `repos/${repo}/issues`, { title: "Issue", body: "issue body" })).number;
  sha = (await commitFile(repo, "feature", "feature.txt", "one\ntwo\nthree\n")).commit.sha;
  pull = (await admin("POST", `repos/${repo}/pulls`, {
    title: "Pull", body: `Fixes #${issue}`, head: "feature", base: "main",
  })).number;
});

after(() => h.close());

describe("gh api REST", () => {
  test("GET user", () => {
    assert.equal(h.ok(["api", "user", "--jq", ".login"]).trim(), h.login);
  });

  test("GET /user/repos", () => {
    const repos = lines(h.ok(["api", "/user/repos", "-X", "GET", "-f", "per_page=100", "--paginate",
      "--jq", ".[] | select(.permissions.push and (.archived | not)) | {name: .full_name, branch: .default_branch} | @json"]));
    assert.ok(repos.some((entry) => entry.name === repo && entry.branch === "main"));
  });

  test("GET repos/R", () => {
    const facts = h.json(["api", `repos/${repo}`]);
    assert.equal(typeof facts.id, "number");
    assert.equal(facts.visibility, "public");
    assert.equal(facts.permissions.push, true);
  });

  test("GET repos/R/issues/N", () => {
    const shown = h.json(["api", `repos/${repo}/issues/${issue}`]);
    assert.equal(shown.user.login, h.login);
    assert.equal(shown.title, "Issue");
    assert.equal(shown.body, "issue body");
    assert.equal(shown.pull_request, undefined);
    assert.ok(h.json(["api", `repos/${repo}/issues/${pull}`]).pull_request);
    const home = h.ok(["api", `repos/${repo}/issues/${issue}`, "--jq", '"\\(.repository_url)#\\(.number)"']);
    assert.match(home.trim(), new RegExp(`/repos/${repo}#${issue}$`));
    const missing = h.gh(["api", `repos/${repo}/issues/9999`]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.err, /HTTP 404/);
  });

  test("GET and DELETE repos/R/issues/N/labels", async () => {
    await admin("POST", `repos/${repo}/issues/${issue}/labels`, { labels: ["agent-task", "refresh"] });
    assert.deepEqual(h.ok(["api", `repos/${repo}/issues/${issue}/labels`, "--jq", ".[].name"]).trim().split("\n").sort(),
      ["agent-task", "refresh"]);
    h.ok(["api", "-X", "DELETE", `repos/${repo}/issues/${issue}/labels/refresh`]);
    assert.deepEqual((await admin<any[]>("GET", `repos/${repo}/issues/${issue}/labels`)).map((label) => label.name),
      ["agent-task"]);
  });

  test("issue comments: list, edit, delete, react", async () => {
    const posted = await admin("POST", `repos/${repo}/issues/${issue}/comments`,
      { body: "note <!-- agent:card -->" });
    const ids = h.ok(["api", `repos/${repo}/issues/${issue}/comments`, "-X", "GET", "-f", "per_page=100",
      "--paginate", "--jq", `.[] | select(.user.login == "${h.login}") | select((.body // "") | contains("<!-- agent:card -->")) | .id`]);
    assert.equal(Number(ids.trim()), posted.id);

    h.ok(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${posted.id}`, "--input", input({ body: "edited" })]);
    assert.equal((await admin("GET", `repos/${repo}/issues/comments/${posted.id}`)).body, "edited");

    const since = new Date(Date.now() - 60_000).toISOString();
    const listed = lines(h.ok(["api", `repos/${repo}/issues/${issue}/comments`, "-X", "GET", "-f", "per_page=100",
      "-f", `since=${since}`, "--paginate", "--jq",
      '.[] | {id: .id, author: .user.login, created: (.created_at // .submitted_at), body: (.body // "")} | @json']));
    assert.ok(listed.some((comment) => comment.id === posted.id && comment.body === "edited"));

    const reaction = h.json(["api", "-X", "POST", `repos/${repo}/issues/comments/${posted.id}/reactions`,
      "-f", "content=eyes"]);
    const reactions = lines(h.ok(["api", `repos/${repo}/issues/comments/${posted.id}/reactions`, "-X", "GET",
      "-f", "per_page=100", "--paginate", "--jq", ".[] | {id: .id, user: .user.login, content: .content} | @json"]));
    assert.deepEqual(reactions, [{ id: reaction.id, user: h.login, content: "eyes" }]);
    h.ok(["api", "-X", "DELETE", `repos/${repo}/issues/comments/${posted.id}/reactions/${reaction.id}`]);
    assert.deepEqual(await admin("GET", `repos/${repo}/issues/comments/${posted.id}/reactions`) ?? [], []);

    h.ok(["api", "-X", "DELETE", `repos/${repo}/issues/comments/${posted.id}`]);
    const left = await admin<any[]>("GET", `repos/${repo}/issues/${issue}/comments`);
    assert.ok(!left.some((comment) => comment.id === posted.id));
  });

  test("GET repos/R/issues/N/timeline", async () => {
    await admin("POST", `repos/${repo}/issues/${issue}/labels`, { labels: ["refresh"] });
    await admin("PATCH", `repos/${repo}/issues/${issue}`, { assignees: [h.login] });
    const changes = lines(h.ok(["api", `repos/${repo}/issues/${issue}/timeline`, "-X", "GET", "-f", "per_page=100",
      "--paginate", "--jq", '.[] | select(.event == "labeled" or .event == "unlabeled" or .event == "assigned" or .event == "unassigned") | {event, subject: (.label.name // .assignee.login // ""), actor: (.actor.login // "")} | @json']));
    assert.ok(changes.some((change) => change.event === "labeled" && change.subject === "refresh"));
    assert.ok(changes.some((change) => change.event === "assigned" && change.subject === h.login));
  });

  test("GET repos/R/issues", async () => {
    const newest = h.ok(["api", `repos/${repo}/issues`, "-X", "GET", "-f", "state=all", "-f", "sort=created",
      "-f", "direction=desc", "-f", "per_page=1", "--jq", ".[0].number"]);
    assert.equal(Number(newest), pull);
    const labelled = h.ok(["api", `repos/${repo}/issues`, "-X", "GET", "-f", "state=all", "-f", "labels=agent-task",
      "-f", "per_page=100", "--paginate", "--jq", ".[].title"]);
    assert.match(labelled, /Issue/);
    const mine = lines(h.ok(["api", `repos/${repo}/issues`, "-X", "GET", "-f", "state=all", "-f", `creator=${h.login}`,
      "-f", "sort=created", "-f", "direction=desc", "-f", "per_page=100", "-f", "page=1", "--jq",
      '.[] | {number, body: (.body // ""), state, reason: .state_reason, created: .created_at, pull: (.pull_request != null)} | @json']));
    assert.deepEqual(mine.map((entry) => [entry.number, entry.pull]), [[pull, true], [issue, false]]);
  });

  test("GET /issues", async () => {
    const queued = lines(h.ok(["api", "/issues", "-X", "GET", "-f", "per_page=100", "--paginate",
      "-f", "state=open", "-f", "filter=all", "-f", "labels=agent-task", "--jq",
      '.[] | {repo: .repository.full_name, number: .number, title: .title, kind: (if .pull_request then "pr" else "issue" end)} | @json']));
    assert.ok(queued.some((item) => item.repo === repo && item.number === issue && item.kind === "issue"));

    await admin("PATCH", `repos/${repo}/issues/${issue}`, { assignees: [h.login] });
    const assigned = lines(h.ok(["api", "/issues", "-X", "GET", "-f", "per_page=100", "--paginate",
      "-f", "state=open", "-f", "filter=assigned", "--jq", ".[] | {repo: .repository.full_name, number} | @json"]));
    assert.ok(assigned.some((item) => item.repo === repo && item.number === issue));
  });

  test("GET /issues filter=mentioned and /notifications", async () => {
    const alice = await otherUser("alice");
    await admin("PUT", `repos/${repo}/collaborators/${alice.login}`, { permission: "write" });
    const mentioned = (await admin("POST", `repos/${repo}/issues`, { title: "Mention", body: "plain" })).number;
    await admin("POST", `repos/${repo}/issues/${mentioned}/comments`, { body: `@${h.login} please look` },
      alice.token);
    const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 19) + "Z";

    const items = lines(h.ok(["api", "/issues", "-X", "GET", "-f", "filter=mentioned", "-f", "state=all",
      "-f", "per_page=100", "-f", `since=${since}`, "--paginate", "--jq", ".[] | {repo: .repository.full_name, number} | @json"]));
    assert.ok(items.some((item) => item.repo === repo && item.number === mentioned));

    const notices = lines(h.ok(["api", "/notifications", "-X", "GET", "-f", "all=true", "-f", `since=${since}`,
      "-f", "per_page=100", "--paginate", "--jq", `.[] | select(.subject.type == "Issue" or .subject.type == "PullRequest" or .subject.type == "Commit") | {repo: .repository.full_name, number: (if .subject.type == "Commit" then 0 else .subject.url | split("/") | last | tonumber end), kind: ({PullRequest: "pr", Issue: "issue", Commit: "commit"}[.subject.type]), reason: .reason, updated: (.updated_at // "")} | @json`]));
    const notice = notices.find((entry) => entry.repo === repo && entry.number === mentioned);
    assert.ok(notice, JSON.stringify(notices));
    assert.equal(notice.reason, "mention");
    assert.equal(notice.kind, "issue");

    const probe = h.gh(["api", "/notifications", "-X", "GET", "-f", "all=true", "-f", `since=${since}`,
      "-f", "per_page=1", "--include"]);
    const stamp = /^last-modified:\s*(.+)$/im.exec(probe.out)?.[1]?.trim();
    assert.ok(stamp, probe.out);
    const unchanged = h.gh(["api", "/notifications", "-X", "GET", "-f", "all=true", "-f", `since=${since}`,
      "-f", "per_page=1", "--include", "-H", `If-Modified-Since: ${stamp}`]);
    assert.ok(/\b304\b/.test(unchanged.err) || /^HTTP\S* 304\b/im.test(unchanged.out), unchanged.err + unchanged.out);
  });

  test("POST and DELETE repos/R/issues/N/dependencies/blocked_by", async () => {
    const blocker = await admin("POST", `repos/${repo}/issues`, { title: "Blocker", body: "" });
    const blocked = await admin("POST", `repos/${repo}/issues`, { title: "Blocked", body: "" });
    h.ok(["api", "-X", "POST", `repos/${repo}/issues/${blocked.number}/dependencies/blocked_by`,
      "-F", `issue_id=${blocker.id}`]);
    const deps = await admin<any[]>("GET", `repos/${repo}/issues/${blocked.number}/dependencies`);
    assert.deepEqual(deps.map((entry) => entry.number), [blocker.number]);
    h.ok(["api", "-X", "DELETE", `repos/${repo}/issues/${blocked.number}/dependencies/blocked_by/${blocker.id}`]);
    assert.deepEqual(await admin("GET", `repos/${repo}/issues/${blocked.number}/dependencies`), []);
  });

  test("GET repos/R/pulls/N", () => {
    const shown = h.json(["api", `repos/${repo}/pulls/${pull}`]);
    assert.equal(shown.head.ref, "feature");
    assert.equal(shown.head.repo.full_name, repo);
    assert.equal(shown.base.repo.full_name, repo);
  });

  test("GET repos/R/pulls/N/commits", () => {
    const commits = lines(h.ok(["api", `repos/${repo}/pulls/${pull}/commits`, "-X", "GET", "-f", "per_page=100",
      "--paginate", "--jq", '.[] | {sha, author: (.author.login // "")} | @json']));
    assert.deepEqual(commits.map((commit) => commit.sha), [sha]);
  });

  test("pull request reviews and review comments", async () => {
    const created = h.json(["api", "-X", "POST", `repos/${repo}/pulls/${pull}/reviews`, "--input", input({
      body: "### Independent review (advisory)", event: "COMMENT",
      comments: [{ path: "feature.txt", side: "RIGHT", line: 2, body: "Line two?" }],
    })]);
    const summaries = lines(h.ok(["api", `repos/${repo}/pulls/${pull}/reviews`, "-X", "GET", "-f", "per_page=100",
      "--paginate", "--jq", '.[] | select(.state != "PENDING" and .state != "DISMISSED" and (.body // "") != "") | {id: .id, author: .user.login, created: (.created_at // .submitted_at), body: (.body // ""), state: (.state // "")} | @json']));
    assert.ok(summaries.some((review) => review.id === created.id && review.state === "COMMENTED"));

    const mine = h.ok(["api", `repos/${repo}/pulls/${pull}/reviews`, "--paginate", "--jq",
      `.[] | select(.user.login == "${h.login}") | select(.state == "COMMENTED") | select((.body // "") | contains("### Independent review (advisory)")) | .id`]);
    assert.equal(Number(mine.trim()), created.id);

    const commentIds = h.ok(["api", `repos/${repo}/pulls/${pull}/reviews/${created.id}/comments`, "--paginate",
      "--jq", ".[] | .id"]).trim().split("\n").map(Number);
    assert.equal(commentIds.length, 1);

    const onDiff = lines(h.ok(["api", `repos/${repo}/pulls/${pull}/comments`, "-X", "GET", "-f", "per_page=100",
      "--paginate", "--jq", '.[] | {id: .id, author: .user.login, body: (.body // ""), replyTo: (.in_reply_to_id // 0), path: (.path // ""), line: (.line // .original_line // 0), commit: (.commit_id // "")} | @json']));
    assert.deepEqual(onDiff.map((comment) => [comment.id, comment.path, comment.line, comment.body]),
      [[commentIds[0], "feature.txt", 2, "Line two?"]]);

    h.ok(["api", "-X", "POST", `repos/${repo}/pulls/${pull}/comments/${commentIds[0]}/replies`, "-f", "body=Yes."]);
    const thread = lines(h.ok(["api", `repos/${repo}/pulls/${pull}/comments`, "--paginate", "--jq",
      ".[] | {path, line, body} | @json"]));
    assert.deepEqual(thread.map((comment) => [comment.path, comment.line, comment.body]),
      [["feature.txt", 2, "Line two?"], ["feature.txt", 2, "Yes."]]);

    const reaction = h.json(["api", "-X", "POST", `repos/${repo}/pulls/comments/${commentIds[0]}/reactions`,
      "-f", "content=+1"]);
    assert.equal(reaction.content, "+1");

    const pending = h.json(["api", "-X", "POST", `repos/${repo}/pulls/${pull}/reviews`, "--input", input({ body: "draft" })]);
    h.ok(["api", "-X", "DELETE", `repos/${repo}/pulls/${pull}/reviews/${pending.id}`]);
    const left = await admin<any[]>("GET", `repos/${repo}/pulls/${pull}/reviews`);
    assert.ok(!left.some((review) => review.id === pending.id));
  });

  test("POST repos/R/pulls/N/requested_reviewers", async () => {
    const bob = await otherUser("bob");
    await admin("PUT", `repos/${repo}/collaborators/${bob.login}`, { permission: "write" });
    h.ok(["api", "-X", "POST", `repos/${repo}/pulls/${pull}/requested_reviewers`, "-f", `reviewers[]=${bob.login}`]);
    const shown = await admin("GET", `repos/${repo}/pulls/${pull}`);
    assert.ok(shown.requested_reviewers.some((user: any) => user.login === bob.login));
  });

  test("PUT repos/R/pulls/N/update-branch", async () => {
    await commitFile(repo, "main", "later.txt", "later\n");
    h.ok(["api", "-X", "PUT", `repos/${repo}/pulls/${pull}/update-branch`]);
    const commits = await admin<any[]>("GET", `repos/${repo}/pulls/${pull}/commits`);
    assert.ok(commits.length > 1);
  });

  test("GET repos/R/commits/SHA/status", async () => {
    await admin("POST", `repos/${repo}/statuses/${sha}`, {
      context: "ci / test", state: "failure", target_url: "https://ci.example.com/1",
    });
    const statuses = lines(h.ok(["api", `repos/${repo}/commits/${sha}/status`, "--jq",
      ".statuses[] | {context, state, targetUrl: .target_url} | @json"]));
    assert.deepEqual(statuses, [{ context: "ci / test", state: "failure", targetUrl: "https://ci.example.com/1" }]);
  });

  test("GET repos/R/commits/SHA/check-runs", () => {
    const runs = h.json(["api", `repos/${repo}/commits/${sha}/check-runs`, "-X", "GET", "-f", "per_page=100"]);
    assert.deepEqual(runs, { total_count: 0, check_runs: [] });
  });

  test("GET repos/R/contents/PATH raw", () => {
    const text = h.ok(["api", `repos/${repo}/contents/feature.txt`, "-X", "GET", "-f", "ref=feature",
      "-H", "Accept: application/vnd.github.raw"]);
    assert.equal(text, "one\ntwo\nthree\n");
  });

  test("GET repos/R/commits/REF", async () => {
    const head = (await admin("GET", `repos/${repo}/branches/feature`)).commit.id;
    assert.equal(h.ok(["api", `repos/${repo}/commits/feature`, "--jq", ".sha"]).trim(), head);
  });

  test("GET repos/R/git/ref and POST repos/R/git/refs", () => {
    assert.notEqual(h.gh(["api", `repos/${repo}/git/ref/heads/made`]).code, 0);
    h.ok(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", "ref=refs/heads/made", "-f", `sha=${sha}`]);
    assert.equal(h.json(["api", `repos/${repo}/git/ref/heads/made`]).object.sha, sha);
  });

  test("POST repos/R/forks", async () => {
    const alice = await otherUser("alice");
    const fork = h.gh(["api", "-X", "POST", `repos/${repo}/forks`, "--jq", ".full_name"],
      { env: { GH_ENTERPRISE_TOKEN: alice.token } });
    assert.equal(fork.code, 0, fork.err);
    assert.equal(fork.out.trim(), `${alice.login}/${repo.split("/")[1]}`);
  });

  test("POST repos/R/actions/runners/registration-token", () => {
    assert.match(h.ok(["api", "-X", "POST", `repos/${repo}/actions/runners/registration-token`, "--jq", ".token"]),
      /\w{20,}/);
  });

  test("gh api -i /user rate limit headers", () => {
    assert.match(h.ok(["api", "-i", "/user"]), /^x-ratelimit-remaining: \d+/im);
  });
});
