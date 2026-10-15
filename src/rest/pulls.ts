import type { GCommit, GPull, GReview, GReviewComment } from "../types.ts";
import { field, paged, reply, RestError, route } from "./router.ts";
import * as shape from "./shape.ts";

const R = "repos/:owner/:repo";
const P = `${R}/pulls/:number`;
const repoName = (params: Record<string, string>) => `${params.owner}/${params.repo}`;
const pullPath = (params: Record<string, string>) => `repos/${repoName(params)}/pulls/${params.number}`;

route("GET", `${R}/pulls`, async (request) => {
  const repo = repoName(request.params);
  const state = field(request, "state") ?? "open";
  const head = field(request, "head")?.replace(/^[^:]+:/, "");
  const base = field(request, "base");
  const pulls = await request.gitea.all<GPull>(`repos/${repo}/pulls`, { state });
  const wanted = pulls.filter((pull) => (!head || pull.head.ref === head) && (!base || pull.base.ref === base));
  return paged(request, `repos/${repo}/pulls`, wanted.map((pull) => shape.pull(request.origin, pull)));
});

/** A pull request as JSON, or its diff or patch when the Accept header asks for one. */
route("GET", P, async ({ gitea, params, headers, origin }) => {
  const accept = String(headers.accept ?? "");
  const format = accept.includes("diff") ? "diff" : accept.includes("patch") ? "patch" : undefined;
  if (format) {
    const response = await gitea.raw("GET", `${pullPath(params)}.${format}`, {}, undefined, "*/*");
    return reply({ raw: await response.text() });
  }
  return shape.pull(origin, await gitea.get<GPull>(pullPath(params)));
});

route("PATCH", P, async ({ gitea, params, body, origin }) => {
  const current = await gitea.get<GPull>(pullPath(params));
  const title = body.title === undefined ? undefined : shape.draftTitle(body.title, current.draft);
  const updated = await gitea.call<GPull>("PATCH", pullPath(params), undefined,
    { title, body: body.body, state: body.state, base: body.base });
  return shape.pull(origin, updated);
});

route("POST", `${R}/pulls`, async ({ gitea, params, body, origin }) => {
  const created = await gitea.call<GPull>("POST", `repos/${repoName(params)}/pulls`, undefined, {
    title: shape.draftTitle(body.title, Boolean(body.draft)), body: body.body ?? "",
    head: body.head, base: body.base,
  });
  return reply({ status: 201, body: shape.pull(origin, created) });
});

route("GET", `${P}/commits`, async (request) => {
  const commits = await request.gitea.all<GCommit>(`${pullPath(request.params)}/commits`,
    { stat: false, files: false, verification: false });
  return paged(request, `${pullPath(request.params)}/commits`, commits.map((commit) => ({
    sha: commit.sha, commit: commit.commit, html_url: commit.html_url,
    author: shape.user(commit.author), committer: shape.user(commit.committer),
    parents: commit.parents ?? [],
  })));
});

route("GET", `${P}/files`, async (request) => {
  const files = await request.gitea.all<any>(`${pullPath(request.params)}/files`);
  return paged(request, `${pullPath(request.params)}/files`, files);
});

route("GET", `${P}/reviews`, async (request) => {
  const reviews = await request.gitea.all<GReview>(`${pullPath(request.params)}/reviews`);
  return paged(request, `${pullPath(request.params)}/reviews`, reviews.map(shape.review));
});

const EVENTS: Record<string, string> = {
  APPROVE: "APPROVED", REQUEST_CHANGES: "REQUEST_CHANGES", COMMENT: "COMMENT",
};

/** A review, with GitHub's `line` and `side` turned into Gitea's new and old positions. */
route("POST", `${P}/reviews`, async ({ gitea, params, body }) => {
  const comments = (body.comments ?? []).map((comment: any) => ({
    path: comment.path, body: comment.body,
    new_position: comment.side === "LEFT" ? 0 : comment.line ?? comment.position ?? 0,
    old_position: comment.side === "LEFT" ? comment.line ?? 0 : 0,
  }));
  const created = await gitea.call<GReview>("POST", `${pullPath(params)}/reviews`, undefined, {
    body: body.body ?? "", event: body.event ? EVENTS[body.event] ?? body.event : "PENDING",
    comments, commit_id: body.commit_id,
  });
  return shape.review(created);
});

route("GET", `${P}/reviews/:id`, async ({ gitea, params }) =>
  shape.review(await gitea.get<GReview>(`${pullPath(params)}/reviews/${params.id}`)));

route("PUT", `${P}/reviews/:id`, async () => {
  throw new RestError(422, "Gitea cannot edit a submitted review's body");
});

route("DELETE", `${P}/reviews/:id`, async ({ gitea, params }) => {
  const review = await gitea.get<GReview>(`${pullPath(params)}/reviews/${params.id}`);
  await gitea.call("DELETE", `${pullPath(params)}/reviews/${params.id}`);
  return shape.review(review);
});

route("GET", `${P}/reviews/:id/comments`, async (request) => {
  const { gitea, params, origin } = request;
  const path = `${pullPath(params)}/reviews/${params.id}/comments`;
  const comments = await gitea.all<GReviewComment>(path);
  return paged(request, path, comments.map((comment) => shape.reviewComment(origin, repoName(params), comment)));
});

/** Every comment on the diff across the pull request's reviews, oldest first. */
async function reviewComments(request: Parameters<Parameters<typeof route>[2]>[0]) {
  const { gitea, params } = request;
  const reviews = await gitea.all<GReview>(`${pullPath(params)}/reviews`);
  const lists = await Promise.all(reviews.filter((review) => review.comments_count > 0)
    .map((review) => gitea.all<GReviewComment>(`${pullPath(params)}/reviews/${review.id}/comments`)));
  return lists.flat().sort((one, other) => one.created_at.localeCompare(other.created_at));
}

route("GET", `${P}/comments`, async (request) => {
  const since = field(request, "since");
  const comments = (await reviewComments(request))
    .filter((comment) => !since || comment.updated_at >= since);
  return paged(request, `${pullPath(request.params)}/comments`,
    comments.map((comment) => shape.reviewComment(request.origin, repoName(request.params), comment)));
});

/** A reply is a new review comment on the line of the one replied to, which Gitea threads with it. */
route("POST", `${P}/comments/:id/replies`, async (request) => {
  const { gitea, params, body, origin } = request;
  const parent = (await reviewComments(request)).find((comment) => String(comment.id) === params.id);
  if (!parent) throw new RestError(404, "Not Found");
  const review = await gitea.call<GReview>("POST", `${pullPath(params)}/reviews`, undefined, {
    body: "", event: "COMMENT", commit_id: parent.commit_id,
    comments: [{ path: parent.path, body: body.body,
      new_position: parent.position, old_position: parent.position ? 0 : parent.original_position }],
  });
  const [created] = await gitea.call<GReviewComment[]>("GET",
    `${pullPath(params)}/reviews/${review.id}/comments`);
  return reply({ status: 201, body: shape.reviewComment(origin, repoName(params), created) });
});

route("POST", `${P}/requested_reviewers`, async ({ gitea, params, body, origin }) => {
  await gitea.call("POST", `${pullPath(params)}/requested_reviewers`, undefined,
    { reviewers: body.reviewers ?? body["reviewers[]"] ?? [] });
  gitea.forget();
  return reply({ status: 201, body: shape.pull(origin, await gitea.get<GPull>(pullPath(params))) });
});

route("PUT", `${P}/update-branch`, async ({ gitea, params }) => {
  await gitea.call("POST", `${pullPath(params)}/update`, { style: "merge" });
  return reply({ status: 202, body: { message: "Updating pull request branch." } });
});

route("PUT", `${P}/merge`, async ({ gitea, params, body }) => {
  await gitea.call("POST", `${pullPath(params)}/merge`, undefined, {
    Do: body.merge_method ?? "merge", MergeTitleField: body.commit_title,
    MergeMessageField: body.commit_message, head_commit_id: body.sha,
  });
  return { merged: true, message: "Pull Request successfully merged" };
});
