import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { admin, freshRepo, type Harness, harness } from "./harness.ts";

let h: Harness;
let repo: string;

before(async () => {
  h = await harness();
  repo = await freshRepo("repos");
  await admin("POST", `repos/${repo}/releases`, { tag_name: "v1.0.0", name: "v1.0.0", body: "First" });
  await admin("POST", `repos/${repo}/releases`, { tag_name: "v1.1.0", name: "v1.1.0", body: "Second" });
});

after(() => h.close());

describe("gh subcommands", () => {
  test("gh release view", () => {
    const printed = h.ok(["release", "view", "--repo", repo]);
    assert.match(printed, /v1\.1\.0/);
    assert.match(printed, /Second/);
    const json = h.json(["release", "view", "v1.0.0", "--repo", repo, "--json", "tagName,body"]);
    assert.deepEqual(json, { tagName: "v1.0.0", body: "First" });
  });

  test("gh release list", () => {
    const listed = h.json(["release", "list", "--repo", repo, "--json", "tagName,isLatest"]);
    assert.deepEqual(listed.map((release: any) => release.tagName), ["v1.1.0", "v1.0.0"]);
    assert.equal(listed[0].isLatest, true);
  });

  test("gh repo clone, then git push through gh auth setup-git", () => {
    const directory = join(mkdtempSync(join(tmpdir(), "gh-gitea-proxy-clone-")), "clone");
    h.ok(["auth", "setup-git", "--hostname", h.host]);
    h.ok(["repo", "clone", repo, directory, "--", "--quiet"]);
    const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args],
      { encoding: "utf8", env: { ...process.env, ...h.env } });
    assert.match(git("remote", "get-url", "origin"), new RegExp(`${h.host}/${repo}`));
    writeFileSync(join(directory, "pushed.txt"), "pushed\n");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "add", "pushed.txt");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "push");
    git("push", "-q", "origin", "HEAD:pushed");
    assert.match(git("ls-remote", "origin", "refs/heads/pushed"), /refs\/heads\/pushed/);
  });

  // gh matches a clone's remote to GH_HOST by hostname alone, so this needs the proxy on 443.
  test("gh repo view in a clone", { skip: process.env.PROXY_PORT !== "443" && "needs PROXY_PORT=443" }, () => {
    const directory = join(mkdtempSync(join(tmpdir(), "gh-gitea-proxy-view-")), "clone");
    h.ok(["repo", "clone", repo, directory, "--", "--quiet"]);
    const name = h.ok(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { cwd: directory }).trim();
    assert.equal(name, repo);
  });
});
