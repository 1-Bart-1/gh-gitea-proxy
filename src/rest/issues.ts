import type { Gitea } from "../gitea.ts";
import type { GComment, GIssue, GLabel, GReaction, GTimelineEvent } from "../types.ts";
import { field, paged, reply, RestError, route, type RestRequest } from "./router.ts";
import * as shape from "./shape.ts";

const R = "repos/:owner/:repo";
const repoName = (params: Record<string, string>) => `${params.owner}/${params.repo}`;

/** Sort as GitHub's `sort` and `direction` ask, newest created first by default. */
function sorted(request: RestRequest, issues: GIssue[]): GIssue[] {
  const key = field(request, "sort") === "updated" ? "updated_at" : "created_at";
  const sign = field(request, "direction") === "asc" ? 1 : -1;
  return [...issues].sort((one, other) => sign * one[key].localeCompare(other[key]));
}

route("GET", `${R}/issues`, async (request) => {
  const repo = repoName(request.params);
  const issues = await request.gitea.all<GIssue>(`repos/${repo}/issues`, {
    state: field(request, "state") ?? "open", labels: field(request, "labels"),
    created_by: field(request, "creator"), assigned_by: field(request, "assignee"),
    mentioned_by: field(request, "mentioned"), since: field(request, "since"),
  });
  return paged(request, `repos/${repo}/issues`,
    sorted(request, issues).map((issue) => shape.issue(request.origin, issue)));
});

route("POST", `${R}/issues`, async ({ gitea, params, body, origin }) => {
  const repo = repoName(params);
  const created = await gitea.call<GIssue>("POST", `repos/${repo}/issues`, undefined, {
    title: body.title, body: body.body ?? "", assignees: body.assignees,
    labels: body.labels ? await labelIds(gitea, repo, body.labels) : undefined,
  });
  return reply({ status: 201, body: shape.issue(origin, created) });
});

route("GET", `${R}/issues/:number`, async ({ gitea, params, origin }) =>
  shape.issue(origin, await gitea.get<GIssue>(`repos/${repoName(params)}/issues/${params.number}`)));

route("PATCH", `${R}/issues/:number`, async ({ gitea, params, body, origin }) => {
  const repo = repoName(params);
  const updated = await gitea.call<GIssue>("PATCH", `repos/${repo}/issues/${params.number}`, undefined, {
    title: body.title, body: body.body, state: body.state, assignees: body.assignees,
  });
  if (body.labels) {
    await gitea.call("PUT", `repos/${repo}/issues/${params.number}/labels`, undefined,
      { labels: await labelIds(gitea, repo, body.labels) });
  }
  return shape.issue(origin, updated);
});

/** Gitea label IDs for GitHub label names, or for `{name}` objects. */
async function labelIds(gitea: Gitea, repo: string, names: (string | { name: string })[]) {
  const labels = await gitea.all<GLabel>(`repos/${repo}/labels`);
  return names.map((entry) => {
    const name = typeof entry === "string" ? entry : entry.name;
    const found = labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
    if (!found) throw new RestError(422, `no label named ${name}`);
    return found.id;
  });
}

route("GET", `${R}/issues/:number/labels`, async (request) => {
  const { gitea, params } = request;
  const labels = await gitea.all<GLabel>(`repos/${repoName(params)}/issues/${params.number}/labels`);
  return paged(request, `repos/${repoName(params)}/issues/${params.number}/labels`, labels.map(shape.label));
});

route("POST", `${R}/issues/:number/labels`, async ({ gitea, params, body }) => {
  const repo = repoName(params);
  const names = Array.isArray(body) ? body : body.labels ?? [];
  const labels = await gitea.call<GLabel[]>("POST", `repos/${repo}/issues/${params.number}/labels`,
    undefined, { labels: await labelIds(gitea, repo, names) });
  return labels.map(shape.label);
});

route("DELETE", `${R}/issues/:number/labels/:name`, async ({ gitea, params }) => {
  const repo = repoName(params);
  const [id] = await labelIds(gitea, repo, [params.name]);
  await gitea.call("DELETE", `repos/${repo}/issues/${params.number}/labels/${id}`);
  const left = await gitea.call<GLabel[]>("GET", `repos/${repo}/issues/${params.number}/labels`);
  return left.map(shape.label);
});

route("GET", `${R}/issues/:number/comments`, async (request) => {
  const { gitea, params, origin } = request;
  const repo = repoName(params);
  const comments = await gitea.all<GComment>(`repos/${repo}/issues/${params.number}/comments`,
    { since: field(request, "since") });
  return paged(request, `repos/${repo}/issues/${params.number}/comments`,
    comments.map((comment) => shape.comment(origin, repo, comment)));
});

route("POST", `${R}/issues/:number/comments`, async ({ gitea, params, body, origin }) => {
  const repo = repoName(params);
  const created = await gitea.call<GComment>("POST", `repos/${repo}/issues/${params.number}/comments`,
    undefined, { body: body.body });
  return reply({ status: 201, body: shape.comment(origin, repo, created) });
});

route("GET", `${R}/issues/comments/:id`, async ({ gitea, params, origin }) =>
  shape.comment(origin, repoName(params),
    await gitea.get<GComment>(`repos/${repoName(params)}/issues/comments/${params.id}`)));

route("PATCH", `${R}/issues/comments/:id`, async ({ gitea, params, body, origin }) =>
  shape.comment(origin, repoName(params), await gitea.call<GComment>("PATCH",
    `repos/${repoName(params)}/issues/comments/${params.id}`, undefined, { body: body.body })));

/** Review comments are issue comments on Gitea, so both delete the same way. */
for (const kind of ["issues", "pulls"]) {
  route("DELETE", `${R}/${kind}/comments/:id`, async ({ gitea, params }) => {
    await gitea.call("DELETE", `repos/${repoName(params)}/issues/comments/${params.id}`);
  });
}

/** Where Gitea keeps the reactions of the GitHub subject at `kind` and `id`. */
function reactionPath(params: Record<string, string>): string {
  const repo = repoName(params);
  if (params.number) return `repos/${repo}/issues/${params.number}/reactions`;
  if (params.kind === "issues" || params.kind === "pulls") {
    return `repos/${repo}/issues/comments/${params.id}/reactions`;
  }
  throw new RestError(404, "Gitea has no commit comments");
}

for (const subject of [`${R}/:kind/comments/:id`, `${R}/:kind/:number`]) {
  route("GET", `${subject}/reactions`, async (request) => {
    const path = reactionPath(request.params);
    const reactions = await request.gitea.all<GReaction>(path);
    const content = field(request, "content");
    const wanted = content ? reactions.filter((reaction) => reaction.content === content) : reactions;
    return paged(request, path, wanted.map(shape.reaction));
  });

  route("POST", `${subject}/reactions`, async ({ gitea, params, body }) => {
    const created = await gitea.call<GReaction>("POST", reactionPath(params), undefined,
      { content: body.content });
    return reply({ status: 201, body: shape.reaction(created) });
  });

  route("DELETE", `${subject}/reactions/:reaction`, async ({ gitea, params }) => {
    await gitea.call("DELETE", reactionPath(params), undefined,
      { content: shape.reactionContent(Number(params.reaction)) });
  });
}

const EVENTS: Record<string, (event: GTimelineEvent) => string> = {
  label: (event) => event.body === "1" ? "labeled" : "unlabeled",
  assignees: (event) => event.removed_assignee ? "unassigned" : "assigned",
  comment: () => "commented",
  close: () => "closed",
  reopen: () => "reopened",
  change_title: () => "renamed",
  pull_ref: () => "cross-referenced",
  merge_pull: () => "merged",
};

route("GET", `${R}/issues/:number/timeline`, async (request) => {
  const { gitea, params } = request;
  const repo = repoName(params);
  const events = await gitea.all<GTimelineEvent>(`repos/${repo}/issues/${params.number}/timeline`);
  const shaped = events.filter((event) => EVENTS[event.type]).map((event) => ({
    id: event.id, event: EVENTS[event.type](event), actor: shape.user(event.user),
    created_at: event.created_at, body: event.body,
    label: event.label ? { name: event.label.name, color: event.label.color } : undefined,
    assignee: shape.user(event.assignee),
  }));
  return paged(request, `repos/${repo}/issues/${params.number}/timeline`, shaped);
});

/** The repository and number of the issue with Gitea ID `id`, searched for where it is likeliest. */
async function issueById(gitea: Gitea, repo: string, id: number) {
  const here = await gitea.all<GIssue>(`repos/${repo}/issues`, { state: "all" });
  const local = here.find((issue) => issue.id === id);
  if (local) return { repo, number: local.number };
  const anywhere = await gitea.all<GIssue>("repos/issues/search", { state: "all" });
  const found = anywhere.find((issue) => issue.id === id);
  if (!found) throw new RestError(404, `no issue with id ${id}`);
  return { repo: shape.repoOf(found), number: found.number };
}

route("POST", `${R}/issues/:number/dependencies/blocked_by`, async ({ gitea, params, body, origin }) => {
  const repo = repoName(params);
  const blocker = await issueById(gitea, repo, Number(body.issue_id));
  const [owner, name] = blocker.repo.split("/");
  await gitea.call("POST", `repos/${repo}/issues/${params.number}/dependencies`, undefined,
    { owner, repo: name, index: blocker.number });
  return reply({ status: 201, body: shape.issue(origin,
    await gitea.get<GIssue>(`repos/${blocker.repo}/issues/${blocker.number}`)) });
});

route("DELETE", `${R}/issues/:number/dependencies/blocked_by/:id`, async ({ gitea, params }) => {
  const repo = repoName(params);
  const blocker = await issueById(gitea, repo, Number(params.id));
  const [owner, name] = blocker.repo.split("/");
  await gitea.call("DELETE", `repos/${repo}/issues/${params.number}/dependencies`, undefined,
    { owner, repo: name, index: blocker.number });
});

/** GitHub's `/issues` filters as Gitea's cross-repository issue search takes them. */
const FILTERS: Record<string, Record<string, boolean>> = {
  assigned: { assigned: true }, created: { created: true }, mentioned: { mentioned: true },
  subscribed: {}, repos: {}, all: {},
};

route("GET", "issues", async (request) => {
  const issues = await request.gitea.all<GIssue>("repos/issues/search", {
    ...FILTERS[field(request, "filter") ?? "assigned"],
    state: field(request, "state") ?? "open", labels: field(request, "labels"),
    since: field(request, "since"),
  });
  return paged(request, "issues", sorted(request, issues).map((issue) => shape.issue(request.origin, issue)));
});
