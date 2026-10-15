import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { freshRepo, type Harness, harness } from "./harness.ts";

let h: Harness;
let repo: string;

before(async () => {
  h = await harness();
  repo = await freshRepo("basics");
});

after(() => h.close());

describe("gh subcommands", () => {
  test("gh auth status", () => {
    const result = h.gh(["auth", "status"]);
    assert.equal(result.code, 0, result.err + result.out);
    assert.match(result.err + result.out, new RegExp(h.login));
  });

  test("gh repo view --json nameWithOwner", () => {
    const view = h.json(["repo", "view", repo, "--json", "nameWithOwner"]);
    assert.equal(view.nameWithOwner, repo);
  });
});
