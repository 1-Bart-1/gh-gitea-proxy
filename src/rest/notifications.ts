import type { Gitea } from "../gitea.ts";
import type { GComment, GIssue, GNotification, GUser } from "../types.ts";
import { field, paged, route } from "./router.ts";
import * as shape from "./shape.ts";

/**
 * GitHub's notification `reason`, which Gitea does not record: `mention` when
 * the latest comment names the viewer, `assign` when the viewer is assigned,
 * and `subscribed` otherwise.
 */
async function reasonFor(gitea: Gitea, viewer: string, notification: GNotification): Promise<string> {
  const mentions = new RegExp(`(^|[^\\w@])@${viewer}\\b`, "i");
  const latest = notification.subject.latest_comment_url;
  if (latest) {
    const comment = await gitea.find<GComment>(latest.replace(/^.*\/api\/v1\//, ""));
    if (comment && mentions.test(comment.body)) return "mention";
  }
  if (notification.subject.type !== "Issue" && notification.subject.type !== "Pull") return "subscribed";
  const issue = await gitea.find<GIssue>(notification.subject.url.replace(/^.*\/api\/v1\//, ""));
  if (!issue) return "subscribed";
  if (!latest && mentions.test(issue.body ?? "")) return "mention";
  if ((issue.assignees ?? []).some((user) => user.login === viewer)) return "assign";
  return issue.user.login === viewer ? "author" : "subscribed";
}

/**
 * The viewer's notifications, with `Last-Modified` set to the newest one and a
 * 304 for an `If-Modified-Since` that is not older, so a poller's probe is cheap.
 */
route("GET", "notifications", async (request) => {
  const { gitea, origin } = request;
  const all = field(request, "all") === "true";
  const listed = await gitea.all<GNotification>("notifications", {
    all, since: field(request, "since"), before: field(request, "before"),
    "status-types": all ? ["unread", "read", "pinned"] : ["unread", "pinned"],
  });
  const newest = listed.reduce((latest, entry) => entry.updated_at > latest ? entry.updated_at : latest, "");
  const headers: Record<string, string> = newest ? { "last-modified": new Date(newest).toUTCString() } : {};
  const since = request.headers["if-modified-since"];
  if (since && newest && Date.parse(String(since)) >= Date.parse(new Date(newest).toUTCString())) {
    return { status: 304, headers };
  }
  const viewer = (await gitea.get<GUser>("user")).login;
  const page = paged(request, "notifications", listed);
  const shaped = await Promise.all((page.body as GNotification[]).map(async (entry) =>
    shape.notification(origin, entry, await reasonFor(gitea, viewer, entry))));
  return { body: shaped, headers: { ...page.headers, ...headers } };
});

route("PUT", "notifications", async ({ gitea, body }) => {
  await gitea.call("PUT", "notifications", { last_read_at: body.last_read_at });
  return { status: 205, body: {} };
});

route("PATCH", "notifications/threads/:id", async ({ gitea, params }) => {
  await gitea.call("PATCH", `notifications/threads/${params.id}`, { "to-status": "read" });
  return { status: 205, body: {} };
});
