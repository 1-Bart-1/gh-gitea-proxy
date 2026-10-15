import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { connection } from "../../src/graphql/connection.ts";
import { decodeId, nodeId } from "../../src/graphql/ids.ts";
import { closedIn } from "../../src/graphql/models/issue.ts";
import { qualifiers } from "../../src/graphql/models/search.ts";
import { match, route } from "../../src/rest/router.ts";
import { draftTitle, reactionContent, reactionId, titleOf } from "../../src/rest/shape.ts";

describe("drafts", () => {
  test("a draft's title shows without Gitea's WIP marker", () => {
    assert.equal(titleOf({ title: "WIP: Add it", draft: true }), "Add it");
    assert.equal(titleOf({ title: "[WIP] Add it", draft: true }), "Add it");
    assert.equal(titleOf({ title: "WIP: Add it", draft: false }), "WIP: Add it");
  });

  test("marking a title draft adds one marker and unmarking removes it", () => {
    assert.equal(draftTitle("Add it", true), "WIP: Add it");
    assert.equal(draftTitle("WIP: Add it", true), "WIP: Add it");
    assert.equal(draftTitle("[WIP] Add it", false), "Add it");
  });
});

describe("reactions", () => {
  test("a reaction id round-trips to its content", () => {
    for (const content of ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"]) {
      assert.equal(reactionContent(reactionId(42, content)), content);
    }
    assert.notEqual(reactionId(1, "eyes"), reactionId(2, "eyes"));
  });
});

describe("node ids", () => {
  test("a node id decodes to the type, repository and key it was made from", () => {
    assert.deepEqual(decodeId(nodeId("PullRequest", "o/r", 7)), { type: "PullRequest", repo: "o/r", key: "7" });
    assert.deepEqual(decodeId(nodeId("PullRequestReviewThread", "o/r", "7:12")),
      { type: "PullRequestReviewThread", repo: "o/r", key: "7:12" });
  });
});

describe("connections", () => {
  const items = [1, 2, 3, 4, 5];

  test("first and after page forwards", () => {
    const first = connection(items, { first: 2 });
    assert.deepEqual(first.nodes, [1, 2]);
    assert.equal(first.pageInfo.hasNextPage, true);
    const second = connection(items, { first: 2, after: first.pageInfo.endCursor! });
    assert.deepEqual(second.nodes, [3, 4]);
    assert.equal(second.pageInfo.hasPreviousPage, true);
  });

  test("last takes from the end", () => {
    const last = connection(items, { last: 2 });
    assert.deepEqual(last.nodes, [4, 5]);
    assert.equal(last.pageInfo.hasPreviousPage, true);
    assert.equal(last.pageInfo.hasNextPage, false);
    assert.equal(last.totalCount, 5);
  });
});

describe("search qualifiers", () => {
  test("qualifiers, quoted values and free text separate", () => {
    const { terms, values } = qualifiers('repo:o/r is:issue is:open label:"needs review" author:bot crash');
    assert.deepEqual(terms, ["crash"]);
    assert.deepEqual(values.get("is"), ["issue", "open"]);
    assert.deepEqual(values.get("label"), ["needs review"]);
    assert.deepEqual(values.get("repo"), ["o/r"]);
  });
});

describe("closing keywords", () => {
  test("a body closes the issues GitHub's keywords name", () => {
    assert.deepEqual(closedIn("Fixes #3, closes #4 and resolved #5. Mentions #6."), [3, 4, 5]);
  });
});

describe("routes", () => {
  test("a template captures its parameters, decoded", () => {
    route("GET", "test/:owner/*rest", async () => undefined);
    assert.deepEqual(match("GET", "test/a%3Ab/c/d")?.params, { owner: "a:b", rest: "c/d" });
    assert.equal(match("POST", "test/a/c"), undefined);
  });
});
