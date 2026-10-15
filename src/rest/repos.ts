import { combined, statusesOn } from "../checks.ts";
import type { GCommit, GLabel, GRelease, GRepo } from "../types.ts";
import { paged, reply, RestError, route } from "./router.ts";
import * as shape from "./shape.ts";

const R = "repos/:owner/:repo";
const repoName = (params: Record<string, string>) => `${params.owner}/${params.repo}`;

route("GET", R, async ({ gitea, params, origin }) =>
  shape.repo(origin, await gitea.get<GRepo>(`repos/${repoName(params)}`)));

route("POST", `${R}/forks`, async ({ gitea, params, origin }) =>
  (reply({ status: 202, body: shape.repo(origin, await gitea.call<GRepo>("POST", `repos/${repoName(params)}/forks`, undefined, {})) })));

route("GET", `${R}/labels`, async (request) => {
  const labels = await request.gitea.all<GLabel>(`repos/${repoName(request.params)}/labels`);
  return paged(request, `repos/${repoName(request.params)}/labels`, labels.map(shape.label));
});

/** Create a label, or with gh's `--force` update the one of that name. */
route("POST", `${R}/labels`, async ({ gitea, params, body }) => {
  const repo = repoName(params);
  const labels = await gitea.all<GLabel>(`repos/${repo}/labels`);
  const existing = labels.find((label) => label.name.toLowerCase() === String(body.name).toLowerCase());
  if (existing) {
    return reply({ status: 422, body: { message: "Validation Failed",
      errors: [{ resource: "Label", code: "already_exists", field: "name" }] } });
  }
  const created = await gitea.call<GLabel>("POST", `repos/${repo}/labels`, undefined,
    { name: body.name, color: `#${body.color ?? "ededed"}`, description: body.description ?? "" });
  return reply({ status: 201, body: shape.label(created) });
});

route("PATCH", `${R}/labels/:name`, async ({ gitea, params, body }) => {
  const repo = repoName(params);
  const labels = await gitea.all<GLabel>(`repos/${repo}/labels`);
  const existing = labels.find((label) => label.name.toLowerCase() === params.name.toLowerCase());
  if (!existing) throw new RestError(404, "Not Found");
  const updated = await gitea.call<GLabel>("PATCH", `repos/${repo}/labels/${existing.id}`, undefined, {
    name: body.new_name ?? body.name, description: body.description,
    color: body.color ? `#${body.color}` : undefined,
  });
  return shape.label(updated);
});

/** A file's content, raw when asked for `application/vnd.github.raw`, else GitHub's JSON. */
route("GET", `${R}/contents/*path`, async ({ gitea, params, query, headers }) => {
  const repo = repoName(params);
  const ref = query.get("ref") ?? undefined;
  if (String(headers.accept ?? "").includes("raw")) {
    const response = await gitea.raw("GET", `repos/${repo}/raw/${params.path}`, { ref }, undefined, "*/*");
    return reply({ raw: await response.text() });
  }
  return gitea.get(`repos/${repo}/contents/${params.path}`, { ref });
});

route("GET", `${R}/commits/:ref`, async ({ gitea, params }) => {
  const commit = await gitea.get<GCommit>(`repos/${repoName(params)}/git/commits/${params.ref}`,
    { stat: false, files: false });
  return { ...commit, author: shape.user(commit.author), committer: shape.user(commit.committer) };
});

route("GET", `${R}/git/ref/*ref`, async ({ gitea, params }) => {
  const found = await gitea.get<unknown>(`repos/${repoName(params)}/git/refs/${params.ref}`);
  const list = Array.isArray(found) ? found : [found];
  const exact = list.find((entry: any) => entry.ref === `refs/${params.ref}`);
  if (!exact) throw new RestError(404, "Not Found");
  return exact;
});

/** Create a branch at a commit; tags are not supported. */
route("POST", `${R}/git/refs`, async ({ gitea, params, body }) => {
  const ref = String(body.ref ?? "");
  if (!ref.startsWith("refs/heads/")) throw new RestError(422, "only refs/heads/ can be created");
  await gitea.call("POST", `repos/${repoName(params)}/branches`, undefined,
    { new_branch_name: ref.replace(/^refs\/heads\//, ""), old_ref_name: body.sha });
  return reply({ status: 201, body: { ref, object: { sha: body.sha, type: "commit" } } });
});

/** The statuses something other than Gitea Actions posted, whose jobs are check runs. */
route("GET", `${R}/commits/:sha/status`, async ({ gitea, params }) => {
  const statuses = (await statusesOn(gitea, repoName(params), params.sha)).map(shape.status);
  return {
    state: statuses.length ? combined(statuses.map((status) => status.state)) : "pending",
    sha: params.sha, total_count: statuses.length, statuses,
  };
});

route("GET", `${R}/commits/:sha/statuses`, async (request) => {
  const repo = repoName(request.params);
  const statuses = await request.gitea.all<any>(`repos/${repo}/commits/${request.params.sha}/statuses`);
  return paged(request, `repos/${repo}/commits/${request.params.sha}/statuses`, statuses.map(shape.status));
});

route("POST", `${R}/statuses/:sha`, async ({ gitea, params, body }) => {
  const created = await gitea.call<any>("POST", `repos/${repoName(params)}/statuses/${params.sha}`,
    undefined, body);
  return reply({ status: 201, body: shape.status(created) });
});

/** Gitea has no commit comments: reads are empty and writes are refused. */
route("GET", `${R}/comments`, async () => []);
route("GET", `${R}/commits/:sha/comments`, async () => []);
route("POST", `${R}/commits/:sha/comments`, async () => {
  throw new RestError(422, "Gitea has no commit comments");
});

route("GET", `${R}/releases/latest`, async ({ gitea, params }) =>
  release(await gitea.get<GRelease>(`repos/${repoName(params)}/releases/latest`)));

route("GET", `${R}/releases/tags/:tag`, async ({ gitea, params }) =>
  release(await gitea.get<GRelease>(`repos/${repoName(params)}/releases/tags/${params.tag}`)));

route("GET", `${R}/releases`, async (request) => {
  const repo = repoName(request.params);
  const releases = await request.gitea.all<GRelease>(`repos/${repo}/releases`);
  return paged(request, `repos/${repo}/releases`, releases.map(release));
});

const release = (gitea: GRelease) => ({
  id: gitea.id, tag_name: gitea.tag_name, name: gitea.name, body: gitea.body, draft: gitea.draft,
  prerelease: gitea.prerelease, created_at: gitea.created_at, published_at: gitea.published_at,
  html_url: gitea.html_url, tarball_url: gitea.tarball_url, zipball_url: gitea.zipball_url,
  target_commitish: gitea.target_commitish, author: shape.user(gitea.author), assets: [],
});
