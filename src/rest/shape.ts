/**
 * Gitea objects reshaped into the GitHub REST objects of the same name, with
 * API URLs pointing back at the proxy and HTML URLs left on Gitea.
 */
import type {
  GComment, GIssue, GLabel, GNotification, GPull, GReaction, GRepo, GReview,
  GReviewComment, GStatus, GUser,
} from "../types.ts";

const REACTIONS = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"];

export function user(gitea: GUser | null | undefined) {
  if (!gitea) return null;
  return {
    login: gitea.login, id: gitea.id, type: "User", site_admin: Boolean(gitea.is_admin),
    avatar_url: gitea.avatar_url ?? "", html_url: gitea.html_url ?? "",
    name: gitea.full_name || null, email: gitea.email || null,
  };
}

export const label = (gitea: GLabel) => ({
  id: gitea.id, name: gitea.name, color: gitea.color.replace(/^#/, ""),
  description: gitea.description ?? "", default: false,
});

export function repo(origin: string, gitea: GRepo): Record<string, unknown> {
  return {
    id: gitea.id, name: gitea.name, full_name: gitea.full_name, owner: user(gitea.owner),
    private: gitea.private, visibility: gitea.private ? "private" : "public",
    fork: gitea.fork, archived: Boolean(gitea.archived), description: gitea.description ?? "",
    html_url: gitea.html_url, clone_url: gitea.clone_url, ssh_url: gitea.ssh_url ?? "",
    url: `${origin}/api/v3/repos/${gitea.full_name}`, default_branch: gitea.default_branch,
    has_issues: gitea.has_issues ?? true, created_at: gitea.created_at,
    updated_at: gitea.updated_at,
    permissions: gitea.permissions
      ? { ...gitea.permissions, maintain: gitea.permissions.admin, triage: gitea.permissions.push }
      : undefined,
    parent: gitea.parent ? repo(origin, gitea.parent) : undefined,
  };
}

/** `owner/repo` of an issue, from its search result or its API URL. */
export const repoOf = (gitea: GIssue | GPull): string =>
  ("repository" in gitea && gitea.repository?.full_name) ||
  gitea.url.replace(/^.*\/repos\/([^/]+\/[^/]+)\/.*$/, "$1");

export function issue(origin: string, gitea: GIssue) {
  const full = repoOf(gitea);
  const api = `${origin}/api/v3/repos/${full}`;
  return {
    id: gitea.id, number: gitea.number, title: gitea.title, body: gitea.body,
    state: gitea.state, state_reason: gitea.state === "closed" ? "completed" : null,
    user: user(gitea.user), labels: gitea.labels.map(label),
    assignees: (gitea.assignees ?? []).map(user), assignee: user(gitea.assignees?.[0]),
    comments: gitea.comments, created_at: gitea.created_at, updated_at: gitea.updated_at,
    closed_at: gitea.closed_at, html_url: gitea.html_url, url: `${api}/issues/${gitea.number}`,
    repository_url: api,
    repository: gitea.repository
      ? { id: gitea.repository.id, name: gitea.repository.name, full_name: full }
      : { full_name: full },
    pull_request: gitea.pull_request
      ? { url: `${api}/pulls/${gitea.number}`, html_url: gitea.pull_request.html_url ?? gitea.html_url,
        merged_at: gitea.pull_request.merged_at }
      : undefined,
  };
}

const branch = (gitea: GPull["head"]) => ({
  label: gitea.label, ref: gitea.ref, sha: gitea.sha,
  repo: gitea.repo ? { id: gitea.repo.id, name: gitea.repo.name, full_name: gitea.repo.full_name } : null,
});

export function pull(origin: string, gitea: GPull) {
  const full = repoOf(gitea);
  return {
    ...issue(origin, gitea as unknown as GIssue),
    title: titleOf(gitea),
    url: `${origin}/api/v3/repos/${full}/pulls/${gitea.number}`,
    draft: gitea.draft, merged: gitea.merged, merged_at: gitea.merged_at,
    merged_by: user(gitea.merged_by), merge_commit_sha: gitea.merge_commit_sha,
    mergeable: gitea.mergeable, head: branch(gitea.head), base: branch(gitea.base),
    requested_reviewers: (gitea.requested_reviewers ?? []).map(user),
    additions: gitea.additions ?? 0, deletions: gitea.deletions ?? 0,
    changed_files: gitea.changed_files ?? 0, diff_url: gitea.diff_url,
    pull_request: undefined,
  };
}

/** The draft marker Gitea reads off a pull request's title. */
const DRAFT_PREFIX = "WIP: ";

const DRAFT_MARKERS = /^\s*(WIP:|\[WIP\])\s*/i;

/** A pull request's title without the marker that makes it a draft on Gitea. */
export const titleOf = (gitea: { title: string; draft?: boolean }): string =>
  gitea.draft ? gitea.title.replace(DRAFT_MARKERS, "") : gitea.title;

/** `title` with the draft marker added or removed. */
export const draftTitle = (title: string, draft: boolean): string =>
  draft ? `${DRAFT_PREFIX}${title.replace(DRAFT_MARKERS, "")}` : title.replace(DRAFT_MARKERS, "");

export const comment = (origin: string, repoName: string, gitea: GComment) => ({
  id: gitea.id, body: gitea.body, user: user(gitea.user), created_at: gitea.created_at,
  updated_at: gitea.updated_at, html_url: gitea.html_url,
  url: `${origin}/api/v3/repos/${repoName}/issues/comments/${gitea.id}`,
  issue_url: gitea.issue_url ? `${origin}/api/v3/repos/${repoName}/issues/${
    gitea.issue_url.replace(/^.*\//, "")}` : undefined,
  author_association: "NONE",
});

const REVIEW_STATES: Record<string, string> = {
  APPROVED: "APPROVED", PENDING: "PENDING", COMMENT: "COMMENTED",
  REQUEST_CHANGES: "CHANGES_REQUESTED", REQUEST_REVIEW: "PENDING",
};

/** A Gitea review state as GitHub spells it, `DISMISSED` taking precedence. */
export const reviewState = (gitea: GReview): string =>
  gitea.dismissed ? "DISMISSED" : REVIEW_STATES[gitea.state] ?? "COMMENTED";

export const review = (gitea: GReview) => ({
  id: gitea.id, body: gitea.body, user: user(gitea.user), state: reviewState(gitea),
  commit_id: gitea.commit_id, submitted_at: gitea.submitted_at, html_url: gitea.html_url,
});

export const reviewComment = (origin: string, repoName: string, gitea: GReviewComment) => ({
  id: gitea.id, body: gitea.body, user: user(gitea.user), path: gitea.path,
  line: gitea.position || null, original_line: gitea.original_position || null,
  position: gitea.position || null, original_position: gitea.original_position || null,
  commit_id: gitea.commit_id, original_commit_id: gitea.original_commit_id,
  pull_request_review_id: gitea.pull_request_review_id, diff_hunk: gitea.diff_hunk ?? "",
  created_at: gitea.created_at, updated_at: gitea.updated_at, html_url: gitea.html_url,
  side: "RIGHT",
  url: `${origin}/api/v3/repos/${repoName}/pulls/comments/${gitea.id}`,
});

/**
 * Gitea reactions carry no id, while GitHub deletes one by id. A reaction is
 * identified by who left it and what it is, which this number encodes.
 */
export const reactionId = (userId: number, content: string): number =>
  userId * 16 + Math.max(REACTIONS.indexOf(content), 0);

export const reactionContent = (id: number): string => REACTIONS[id % 16] ?? "+1";

export const reaction = (gitea: GReaction) => ({
  id: reactionId(gitea.user.id, gitea.content), user: user(gitea.user),
  content: gitea.content, created_at: gitea.created_at,
});

const STATUS_STATES: Record<string, string> = {
  pending: "pending", success: "success", error: "error", failure: "failure",
  warning: "success",
};

export const status = (gitea: GStatus) => ({
  id: gitea.id, context: gitea.context, state: STATUS_STATES[gitea.status] ?? "pending",
  description: gitea.description ?? "", target_url: gitea.target_url,
  created_at: gitea.created_at, updated_at: gitea.updated_at,
});

const SUBJECTS: Record<string, string> = {
  Issue: "Issue", Pull: "PullRequest", Commit: "Commit", Repository: "Repository",
};

export function notification(origin: string, gitea: GNotification, reason: string) {
  const full = gitea.repository.full_name;
  const number = gitea.subject.url.replace(/^.*\//, "");
  const kind = gitea.subject.type === "Pull" ? "pulls"
    : gitea.subject.type === "Commit" ? "commits" : "issues";
  return {
    id: String(gitea.id), unread: gitea.unread, reason, updated_at: gitea.updated_at,
    last_read_at: null, repository: repo(origin, gitea.repository),
    subject: {
      title: gitea.subject.title, type: SUBJECTS[gitea.subject.type] ?? gitea.subject.type,
      url: `${origin}/api/v3/repos/${full}/${kind}/${number}`,
      latest_comment_url: gitea.subject.latest_comment_url || null,
    },
    url: `${origin}/api/v3/notifications/threads/${gitea.id}`,
  };
}
