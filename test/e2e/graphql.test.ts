/**
 * The GraphQL reads and writes the Agents box sends, verbatim, each through
 * `gh api graphql` as the box sends it.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { admin, commitFile, freshRepo, type Harness, harness } from "./harness.ts";

let h: Harness;
let repo: string;
let issue: number;
let pull: number;
let sha: string;

const literal = (text: string): string => JSON.stringify(text);

const inRepo = (name: string, selection: string): string => {
  const [owner = "", repoName = ""] = name.split("/");
  return `repository(owner: ${literal(owner)}, name: ${literal(repoName)}) { ${selection} }`;
};

/** The box's `aliased()` batch: one query, one alias per read. */
function aliased(reads: string[]): any[] {
  const query = `query {\n${reads.map((read, index) => `a${index}: ${read}`).join("\n")}\n}`;
  const result = h.gh(["api", "graphql", "-f", `query=${query}`]);
  const data = JSON.parse(result.out || "{}").data ?? {};
  assert.equal(result.code, 0, result.err + result.out);
  return reads.map((_, index) => data[`a${index}`]);
}

before(async () => {
  h = await harness();
  repo = await freshRepo("graphql");
  await admin("POST", `repos/${repo}/labels`, { name: "priority", color: "#b60205" });
  issue = (await admin("POST", `repos/${repo}/issues`, { title: "Issue", body: "issue body" })).number;
  await admin("POST", `repos/${repo}/issues/${issue}/labels`, { labels: ["priority"] });
  await admin("PATCH", `repos/${repo}/issues/${issue}`, { assignees: [h.login] });
  sha = (await commitFile(repo, "feature", "feature.txt", "one\ntwo\n")).commit.sha;
  pull = (await admin("POST", `repos/${repo}/pulls`, {
    title: "WIP: Pull", body: `Closes #${issue}`, head: "feature", base: "main",
  })).number;
  await admin("POST", `repos/${repo}/statuses/${sha}`,
    { context: "ci", state: "success", target_url: "https://ci.example.com/run/1" });
  await admin("POST", `repos/${repo}/issues/${pull}/comments`, { body: "a comment" });
  await admin("POST", `repos/${repo}/pulls/${pull}/reviews`, {
    body: "review body", event: "COMMENT",
    comments: [{ path: "feature.txt", body: "on line 2", new_position: 2 }],
  });
});

after(() => h.close());

describe("gh api graphql", () => {
  test("openPullsIn", () => {
    const [read] = aliased([inRepo(repo, `pullRequests(states: OPEN, first: 50,
        orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage }
      nodes { number title body author { login } createdAt isDraft
        latestReviews(first: 20) { nodes { author { login } state } }
        statusCheckRollup { contexts(first: 100) { nodes {
          ... on CheckRun { conclusion } ... on StatusContext { state } } } } } }`)]);
    const node = read.pullRequests.nodes[0];
    assert.equal(read.pullRequests.pageInfo.hasNextPage, false);
    assert.equal(node.number, pull);
    assert.equal(node.title, "Pull");
    assert.equal(node.isDraft, true);
    assert.deepEqual(node.latestReviews.nodes, [{ author: { login: h.login }, state: "COMMENTED" }]);
    assert.deepEqual(node.statusCheckRollup.contexts.nodes, [{ state: "SUCCESS" }]);
  });

  test("writtenOn", () => {
    const WRITTEN = "databaseId author { login } createdAt updatedAt body";
    const BEYOND = "pageInfo { hasPreviousPage }";
    const THUMBS = `reactions(content: THUMBS_UP, last: 50) { ${BEYOND}
      nodes { databaseId user { login } } }`;
    const conversation = `comments(last: 100) { ${BEYOND} nodes { ${WRITTEN} ${THUMBS} } }`;
    const held = (number: number) => `issueOrPullRequest(number: ${number}) {
      ... on Issue { ${conversation} }
      ... on PullRequest { ${conversation}
        reviews(last: 100) { ${BEYOND} nodes { databaseId author { login } state body submittedAt } }
        reviewThreads(last: 30) { ${BEYOND} nodes { comments(first: 10) {
          pageInfo { hasNextPage } nodes { ${WRITTEN}
            state replyTo { databaseId } path line originalLine commit { oid } } } } }
        commits(last: 100) { ${BEYOND} nodes { commit { oid } } } } }`;
    const COMMIT_COMMENTS = `commitComments(last: 100) { ${BEYOND} nodes { ${WRITTEN}
      path position commit { oid } } }`;
    const [onPull, onIssue, commitComments] = aliased([inRepo(repo, held(pull)), inRepo(repo, held(issue)),
      inRepo(repo, COMMIT_COMMENTS)]);
    const thread = onPull.issueOrPullRequest;
    assert.deepEqual(thread.comments.nodes.map((node: any) => node.body), ["a comment"]);
    assert.equal(thread.comments.pageInfo.hasPreviousPage, false);
    assert.deepEqual(thread.reviews.nodes.map((node: any) => [node.state, node.body]), [["COMMENTED", "review body"]]);
    const [threadComment] = thread.reviewThreads.nodes[0].comments.nodes;
    assert.equal(threadComment.body, "on line 2");
    assert.equal(threadComment.path, "feature.txt");
    assert.equal(threadComment.line, 2);
    assert.equal(threadComment.replyTo, null);
    assert.deepEqual(thread.commits.nodes.map((node: any) => node.commit.oid), [sha]);
    assert.deepEqual(onIssue.issueOrPullRequest.comments.nodes, []);
    assert.deepEqual(commitComments.commitComments.nodes, []);
  });

  test("changesAt", () => {
    const LOGIN = "{ ... on User { login } ... on Bot { login } }";
    const timeline = `timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT,
          ASSIGNED_EVENT, UNASSIGNED_EVENT], last: 100) { pageInfo { hasPreviousPage } nodes { __typename
        ... on LabeledEvent { actor { login } label { name } }
        ... on UnlabeledEvent { actor { login } label { name } }
        ... on AssignedEvent { actor { login } assignee ${LOGIN} }
        ... on UnassignedEvent { actor { login } assignee ${LOGIN} } } }`;
    const [read] = aliased([inRepo(repo, `issueOrPullRequest(number: ${issue}) {
        ... on Issue { ${timeline} } ... on PullRequest { ${timeline} } }`)]);
    const nodes = read.issueOrPullRequest.timelineItems.nodes;
    assert.deepEqual(nodes, [
      { __typename: "LabeledEvent", actor: { login: h.login }, label: { name: "priority" } },
      { __typename: "AssignedEvent", actor: { login: h.login }, assignee: { login: h.login } },
    ]);
  });

  test("threadRead", () => {
    const LABELS = "labels(first: 100) { nodes { name } }";
    const read = (number: number) => inRepo(repo, `issueOrPullRequest(number: ${number}) {
      __typename
      ... on Issue { state stateReason body author { login } ${LABELS} }
      ... on PullRequest { state isDraft body author { login } ${LABELS}
        statusCheckRollup { contexts(first: 100) { nodes {
          ... on CheckRun { name status conclusion detailsUrl }
          ... on StatusContext { context state targetUrl } } } } } }`);
    const [onIssue, onPull, missing] = aliased([read(issue), read(pull), read(9999)]);
    assert.deepEqual(onIssue.issueOrPullRequest, {
      __typename: "Issue", state: "OPEN", stateReason: null, body: "issue body",
      author: { login: h.login }, labels: { nodes: [{ name: "priority" }] },
    });
    assert.equal(onPull.issueOrPullRequest.__typename, "PullRequest");
    assert.equal(onPull.issueOrPullRequest.isDraft, true);
    assert.deepEqual(onPull.issueOrPullRequest.statusCheckRollup.contexts.nodes,
      [{ context: "ci", state: "SUCCESS", targetUrl: "https://ci.example.com/run/1" }]);
    assert.equal(missing.issueOrPullRequest, null);
  });

  test("filesAtHeads", () => {
    const at = (branch: string, path: string) => inRepo(repo, `ref(qualifiedName: ${literal(`refs/heads/${branch}`)}) { target { oid
        ... on Commit { file(path: ${literal(path)}) {
          object { ... on Blob { text isTruncated } } } } } }`);
    const [found, absent, noFile] = aliased([at("feature", "feature.txt"), at("nowhere", "x"), at("main", "x.txt")]);
    assert.equal(found.ref.target.oid, sha);
    assert.deepEqual(found.ref.target.file.object, { text: "one\ntwo\n", isTruncated: false });
    assert.equal(absent.ref, null);
    assert.equal(noFile.ref.target.file, null);
  });

  test("openOnHeads", () => {
    const [read, none] = aliased([
      inRepo(repo, `pullRequests(headRefName: "feature", states: OPEN, first: 1) { nodes { number } }`),
      inRepo(repo, `pullRequests(headRefName: "nothing", states: OPEN, first: 1) { nodes { number } }`),
    ]);
    assert.deepEqual(read.pullRequests.nodes, [{ number: pull }]);
    assert.deepEqual(none.pullRequests.nodes, []);
  });

  test("blockersAt", async () => {
    const blocker = await admin("POST", `repos/${repo}/issues`, { title: "Blocker", body: "" });
    const [owner, name] = repo.split("/");
    await admin("POST", `repos/${repo}/issues/${issue}/dependencies`, { owner, repo: name, index: blocker.number });
    const [read] = aliased([inRepo(repo, `issue(number: ${issue})
      { blockedBy(first: 100) { nodes { number state repository { nameWithOwner } } } }`)]);
    assert.deepEqual(read.issue.blockedBy.nodes,
      [{ number: blocker.number, state: "OPEN", repository: { nameWithOwner: repo } }]);
  });

  test("landedOn", () => {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const [read] = aliased([inRepo(repo, `ref(qualifiedName: "refs/heads/feature") { target {
          ... on Commit { history(since: ${literal(since)}, first: 30) { nodes {
            oid messageHeadline author { user { login } } committer { user { login } }
            associatedPullRequests(first: 5) { nodes { number merged mergedBy { login } } }
          } } } } }`)]);
    const [head] = read.ref.target.history.nodes;
    assert.equal(head.oid, sha);
    assert.equal(head.messageHeadline, "add feature.txt");
    assert.deepEqual(head.associatedPullRequests.nodes, [{ number: pull, merged: false, mergedBy: null }]);
  });

  test("openIssuesIn", () => {
    const [read] = aliased([inRepo(repo, `
      labelledIssues: issues(states: OPEN, labels: ["priority"], first: 100) {
        pageInfo { hasNextPage }
        nodes { number }
      }
      labelledPulls: pullRequests(states: OPEN, labels: ["priority"], first: 100) {
        pageInfo { hasNextPage }
        nodes { number }
      }
      issues(states: OPEN, first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          issueDependenciesSummary { blocking }
          blockedBy(first: 100) { nodes { number state repository { nameWithOwner } } }
          closedByPullRequestsReferences(first: 10) {
            nodes { number repository { nameWithOwner } }
          }
        }
      }`)]);
    assert.deepEqual(read.labelledIssues.nodes, [{ number: issue }]);
    assert.deepEqual(read.labelledPulls.nodes, []);
    const node = read.issues.nodes.find((entry: any) => entry.number === issue);
    assert.deepEqual(node.closedByPullRequestsReferences.nodes, [{ number: pull, repository: { nameWithOwner: repo } }]);
    assert.equal(typeof node.issueDependenciesSummary.blocking, "number");
  });

  test("REVIEW_THREADS and RESOLVE_THREAD", async () => {
    const [owner, name] = repo.split("/");
    const comments = await admin<any[]>("GET", `repos/${repo}/pulls/${pull}/reviews`)
      .then((reviews) => admin<any[]>("GET", `repos/${repo}/pulls/${pull}/reviews/${reviews[0].id}/comments`));
    const threadId = JSON.parse(h.ok(["api", "graphql", "--paginate", "-f", `owner=${owner}`, "-f", `name=${name}`,
      "-F", `number=${pull}`, "-f", `query=query($owner: String!, $name: String!, $number: Int!,
        $endCursor: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $endCursor) {
              nodes { id comments(first: 1) { nodes { databaseId } } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`, "--jq", `.data.repository.pullRequest.reviewThreads.nodes[] | select(.comments.nodes[0].databaseId == ${comments[0].id}) | .id | @json`]));
    const resolved = h.json(["api", "graphql", "-f", `thread=${threadId}`, "-f", `query=mutation($thread: ID!) {
      resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } }
    }`]);
    assert.equal(resolved.data.resolveReviewThread.thread.isResolved, true);
  });

  test("CLOSED_BY", async () => {
    const [owner, name] = repo.split("/");
    await commitFile(repo, "fix", "fix.txt", "fixed\n");
    const merged = await admin("POST", `repos/${repo}/pulls`, {
      title: "Merged fix", body: `Fixes #${issue}`, head: "fix", base: "main",
    });
    await admin("POST", `repos/${repo}/pulls/${merged.number}/merge`, { Do: "merge" });
    const out = h.ok(["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${issue}`,
      "-f", `query=query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          issue(number: $number) {
            closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
              nodes { number title merged additions deletions changedFiles }
            }
          }
        }
      }`, "--jq", ".data.repository.issue.closedByPullRequestsReferences.nodes[] | select(.merged) | @json"]);
    const [node] = out.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(node.title, "Merged fix");
    assert.equal(node.merged, true);
  });

  test("OPEN_THREADS", () => {
    const [owner, name] = repo.split("/");
    const data = h.json(["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-f",
      `query=query($owner: String!, $name: String!) {
        rateLimit { remaining }
        repository(owner: $owner, name: $name) {
          issues(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
            totalCount
            nodes {
              number title url createdAt updatedAt
              author { login }
              labels(first: 30) { nodes { name } }
              comments(last: 1) { nodes { author { login } } }
              issueDependenciesSummary { blocking }
            }
          }
          pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
            totalCount
            nodes {
              number title url createdAt updatedAt isDraft
              author { login }
              baseRefName headRefName additions deletions
              labels(first: 30) { nodes { name } }
              reviewDecision
              comments(last: 1) { nodes { author { login } } }
              closingIssuesReferences(first: 10) {
                nodes { issueDependenciesSummary { blocking } }
              }
              commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
            }
          }
        }
      }`]).data;
    assert.equal(typeof data.rateLimit.remaining, "number");
    assert.ok(data.repository.issues.totalCount >= 1);
    const open = data.repository.pullRequests.nodes.find((node: any) => node.number === pull);
    assert.equal(open.headRefName, "feature");
    assert.equal(open.reviewDecision, "REVIEW_REQUIRED");
    assert.equal(open.closingIssuesReferences.nodes.length, 1);
    assert.equal(open.commits.nodes[0].commit.statusCheckRollup.state, "SUCCESS");
  });

  test("rateLimit", () => {
    const data = h.json(["api", "graphql", "-f", "query={ rateLimit { used remaining resetAt } }"]).data;
    assert.equal(typeof data.rateLimit.remaining, "number");
  });
});
