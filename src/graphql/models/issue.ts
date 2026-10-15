import { reviewState, titleOf } from "../../rest/shape.ts";
import type {
  GComment, GCommit, GIssue, GPull, GReaction, GReview, GReviewComment, GTimelineEvent,
} from "../../types.ts";
import { connection, type Page } from "../connection.ts";
import { type Context, ordered } from "../context.ts";
import { nodeId } from "../ids.ts";
import { Commit, StatusCheckRollup } from "./commit.ts";
import {
  Label, none, reactionGroups, reactionsConnection, User, userOf,
} from "./common.ts";
import { Repository } from "./repository.ts";

/** `#n` references a body closes with GitHub's closing keywords. */
export function closedIn(body: string): number[] {
  const found = body.matchAll(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi);
  return [...new Set([...found].map((match) => Number(match[1])))];
}

/** What `Issue` and `PullRequest` share: the thread around the number. */
abstract class Thread {
  abstract readonly __typename: string;

  readonly context: Context;
  readonly repo: string;
  readonly data: GIssue | GPull;

  constructor(context: Context, repo: string, data: GIssue | GPull) {
    this.context = context;
    this.repo = repo;
    this.data = data;
  }

  protected get gitea() {
    return this.context.gitea;
  }

  get id() {
    return nodeId(this.__typename, this.repo, this.data.number);
  }

  get databaseId() {
    return this.data.id;
  }

  get number() {
    return this.data.number;
  }

  get title() {
    return this.data.title;
  }

  get body() {
    return this.data.body ?? "";
  }

  get bodyText() {
    return this.body;
  }

  get bodyHTML() {
    return this.body;
  }

  get url() {
    return this.data.html_url;
  }

  get resourcePath() {
    return new URL(this.data.html_url).pathname;
  }

  get closed() {
    return this.data.state === "closed";
  }

  get closedAt() {
    return this.data.closed_at;
  }

  get createdAt() {
    return this.data.created_at;
  }

  get updatedAt() {
    return this.data.updated_at;
  }

  get locked() {
    return false;
  }

  get author() {
    return userOf(this.context, this.data.user);
  }

  get authorAssociation() {
    return "NONE";
  }

  get viewerDidAuthor() {
    return false;
  }

  get viewerCanUpdate() {
    return true;
  }

  get milestone() {
    return null;
  }

  repository() {
    return Repository.load(this.context, this.repo);
  }

  labels(args: Page) {
    return connection(this.data.labels.map((label) => new Label(this.repo, label)), args);
  }

  assignees(args: Page) {
    return connection((this.data.assignees ?? []).map((user) => new User(this.context, user)), args);
  }

  participants(args: Page) {
    return connection([new User(this.context, this.data.user)], args);
  }

  projectCards(args: Page) {
    return none(args);
  }

  projectItems(args: Page) {
    return none(args);
  }

  private reactionList() {
    return this.gitea.all<GReaction>(`repos/${this.repo}/issues/${this.data.number}/reactions`);
  }

  async reactions(args: Page & { content?: string }) {
    return reactionsConnection(this.context, this.id, await this.reactionList(), args);
  }

  async reactionGroups() {
    return reactionGroups(this.context, await this.reactionList());
  }

  async comments(args: Page & { orderBy?: unknown }) {
    const listed = await this.gitea.all<GComment>(
      `repos/${this.repo}/issues/${this.data.number}/comments`);
    return connection(listed.map((data) => new IssueComment(this.context, this.repo, data)), args);
  }

  async timelineItems(args: Page & { itemTypes?: string[]; since?: string }) {
    const listed = await this.gitea.all<GTimelineEvent>(
      `repos/${this.repo}/issues/${this.data.number}/timeline`);
    const events = listed.flatMap((event) => timelineEvent(this.context, this.repo, event));
    const wanted = args.itemTypes?.length
      ? events.filter((event) => args.itemTypes!.includes(itemType(event.__typename)))
      : events;
    return connection(wanted, args);
  }
}

/** `LabeledEvent` as the `IssueTimelineItemsItemType` enum spells it. */
const itemType = (typename: string): string =>
  typename.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();

/** The GitHub timeline events one Gitea timeline comment stands for. */
function timelineEvent(context: Context, repo: string, event: GTimelineEvent) {
  const common = {
    id: nodeId("TimelineEvent", repo, event.id), createdAt: event.created_at,
    actor: userOf(context, event.user),
  };
  if (event.type === "label" && event.label) {
    const typename = event.body === "1" ? "LabeledEvent" : "UnlabeledEvent";
    return [{ ...common, __typename: typename, label: new Label(repo, event.label) }];
  }
  if (event.type === "assignees" && event.assignee) {
    const typename = event.removed_assignee ? "UnassignedEvent" : "AssignedEvent";
    return [{ ...common, __typename: typename, assignee: userOf(context, event.assignee) }];
  }
  if (event.type === "close") return [{ ...common, __typename: "ClosedEvent", stateReason: "COMPLETED" }];
  if (event.type === "reopen") return [{ ...common, __typename: "ReopenedEvent" }];
  return [];
}

export class Issue extends Thread {
  readonly __typename = "Issue";

  get state() {
    return this.data.state === "closed" ? "CLOSED" : "OPEN";
  }

  get stateReason() {
    return this.data.state === "closed" ? "COMPLETED" : null;
  }

  get isPinned() {
    return false;
  }

  private async dependencies(kind: "dependencies" | "blocks") {
    return this.gitea.all<GIssue>(`repos/${this.repo}/issues/${this.data.number}/${kind}`);
  }

  async blockedBy(args: Page) {
    const listed = await this.dependencies("dependencies");
    return connection(listed.map((data) => issueFrom(this.context, data)), args);
  }

  async blocking(args: Page) {
    const listed = await this.dependencies("blocks");
    return connection(listed.map((data) => issueFrom(this.context, data)), args);
  }

  async issueDependenciesSummary() {
    const [blockedBy, blocking] = await Promise.all(
      [this.dependencies("dependencies"), this.dependencies("blocks")]);
    const open = (list: GIssue[]) => list.filter((issue) => issue.state === "open").length;
    return {
      blockedBy: open(blockedBy), blocking: open(blocking),
      totalBlockedBy: blockedBy.length, totalBlocking: blocking.length,
    };
  }

  /** Pull requests in this repository whose body closes this issue. */
  async closedByPullRequestsReferences(args: Page & { includeClosedPrs?: boolean }) {
    const pulls = await this.gitea.all<GPull>(`repos/${this.repo}/pulls`, { state: "all" });
    const closing = pulls.filter((pull) => closedIn(pull.body ?? "").includes(this.data.number) &&
      (args.includeClosedPrs || pull.state === "open" || pull.merged));
    return connection(closing.map((data) => new PullRequest(this.context, this.repo, data)), args);
  }

  subIssues(args: Page) {
    return none(args);
  }

  get parent() {
    return null;
  }
}

/** An `Issue` for a dependency, which Gitea lists with its own repository. */
const issueFrom = (context: Context, data: GIssue): Issue =>
  new Issue(context, data.repository?.full_name ??
    data.url.replace(/^.*\/repos\/([^/]+\/[^/]+)\/.*$/, "$1"), data);

export class PullRequest extends Thread {
  readonly __typename = "PullRequest";

  declare readonly data: GPull;

  get title() {
    return titleOf(this.data);
  }

  get state() {
    return this.data.merged ? "MERGED" : this.data.state === "closed" ? "CLOSED" : "OPEN";
  }

  get isDraft() {
    return this.data.draft;
  }

  get merged() {
    return this.data.merged;
  }

  get mergedAt() {
    return this.data.merged_at;
  }

  get mergedBy() {
    return userOf(this.context, this.data.merged_by);
  }

  get mergeCommit() {
    return this.data.merge_commit_sha
      ? new Commit(this.context, this.repo, this.data.merge_commit_sha) : null;
  }

  get mergeable() {
    if (this.data.state !== "open") return "UNKNOWN";
    return this.data.mergeable ? "MERGEABLE" : "CONFLICTING";
  }

  get mergeStateStatus() {
    return this.data.mergeable ? "CLEAN" : "DIRTY";
  }

  get headRefName() {
    return this.data.head.ref;
  }

  get headRefOid() {
    return this.data.head.sha;
  }

  get baseRefName() {
    return this.data.base.ref;
  }

  get baseRefOid() {
    return this.data.base.sha;
  }

  get isCrossRepository() {
    return this.data.head.repo_id !== this.data.base.repo_id;
  }

  get headRepository() {
    return this.data.head.repo ? new Repository(this.context, this.data.head.repo) : null;
  }

  get headRepositoryOwner() {
    return this.data.head.repo ? new User(this.context, this.data.head.repo.owner) : null;
  }

  get baseRepository() {
    return this.data.base.repo ? new Repository(this.context, this.data.base.repo) : null;
  }

  get maintainerCanModify() {
    return true;
  }

  get additions() {
    return this.data.additions ?? 0;
  }

  get deletions() {
    return this.data.deletions ?? 0;
  }

  get changedFiles() {
    return this.data.changed_files ?? 0;
  }

  get autoMergeRequest() {
    return null;
  }

  get permalink() {
    return this.data.html_url;
  }

  private reviewList() {
    return this.gitea.all<GReview>(`repos/${this.repo}/pulls/${this.data.number}/reviews`);
  }

  async reviews(args: Page & { states?: string[]; author?: string }) {
    const listed = (await this.reviewList()).map((data) => new PullRequestReview(this, data));
    const wanted = listed.filter((review) =>
      (!args.states?.length || args.states.includes(review.state)) &&
      (!args.author || review.data.user.login === args.author));
    return connection(wanted, args);
  }

  /** Each reviewer's last review that took a position. */
  async latestReviews(args: Page) {
    const latest = new Map<string, PullRequestReview>();
    for (const data of await this.reviewList()) {
      const review = new PullRequestReview(this, data);
      if (review.state !== "PENDING" && review.state !== "DISMISSED") latest.set(data.user.login, review);
    }
    return connection([...latest.values()], args);
  }

  async latestOpinionatedReviews(args: Page) {
    const latest = await this.latestReviews({});
    return connection(latest.nodes.filter((review) => review.state !== "COMMENTED"), args);
  }

  async reviewDecision() {
    const states = (await this.latestOpinionatedReviews({})).nodes.map((review) => review.state);
    if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
    return states.includes("APPROVED") ? "APPROVED" : "REVIEW_REQUIRED";
  }

  reviewRequests(args: Page) {
    const requested = (this.data.requested_reviewers ?? []).map((user) => ({
      id: nodeId("ReviewRequest", this.repo, `${this.data.number}:${user.login}`),
      requestedReviewer: new User(this.context, user), asCodeOwner: false,
    }));
    return connection(requested, args);
  }

  /** Every comment written on the diff, across all reviews, oldest first. */
  async reviewComments(): Promise<GReviewComment[]> {
    const reviews = await this.reviewList();
    const lists = await Promise.all(reviews.filter((review) => review.comments_count > 0)
      .map((review) => this.gitea.all<GReviewComment>(
        `repos/${this.repo}/pulls/${this.data.number}/reviews/${review.id}/comments`)));
    return ordered(lists.flat(), undefined);
  }

  /** Review comments grouped into threads by the line they were written on. */
  async reviewThreads(args: Page) {
    const threads = new Map<string, GReviewComment[]>();
    for (const comment of await this.reviewComments()) {
      const key = `${comment.path}:${comment.original_position || comment.position}`;
      threads.set(key, [...threads.get(key) ?? [], comment]);
    }
    const nodes = [...threads.values()].map((comments) => new ReviewThread(this, comments));
    return connection(nodes, args);
  }

  async commits(args: Page) {
    const listed = await this.gitea.all<GCommit>(
      `repos/${this.repo}/pulls/${this.data.number}/commits`, { stat: false, files: false });
    const nodes = listed.map((data) => ({
      __typename: "PullRequestCommit",
      id: nodeId("PullRequestCommit", this.repo, data.sha),
      commit: new Commit(this.context, this.repo, data.sha, data),
    }));
    return connection(nodes, args);
  }

  async files(args: Page) {
    const listed = await this.gitea.all<{ filename: string; additions: number; deletions: number;
      status: string }>(`repos/${this.repo}/pulls/${this.data.number}/files`);
    const nodes = listed.map((file) => ({
      path: file.filename, additions: file.additions, deletions: file.deletions,
      changeType: file.status.toUpperCase(),
    }));
    return connection(nodes, args);
  }

  statusCheckRollup() {
    return StatusCheckRollup.load(this.context, this.repo, this.data.head.sha);
  }

  /** Issues in this repository this pull request's body closes. */
  async closingIssuesReferences(args: Page) {
    const issues = await Promise.all(closedIn(this.body).map((number) =>
      this.gitea.find<GIssue>(`repos/${this.repo}/issues/${number}`)));
    const nodes = issues.filter((issue): issue is GIssue => Boolean(issue && !issue.pull_request))
      .map((data) => new Issue(this.context, this.repo, data));
    return connection(nodes, args);
  }

  get potentialMergeCommit() {
    return null;
  }
}

export class IssueComment {
  readonly __typename = "IssueComment";

  readonly context: Context;
  readonly repo: string;
  readonly data: GComment;

  constructor(context: Context, repo: string, data: GComment) {
    this.context = context;
    this.repo = repo;
    this.data = data;
  }

  get id() {
    return nodeId("IssueComment", this.repo, this.data.id);
  }

  get databaseId() {
    return this.data.id;
  }

  get body() {
    return this.data.body;
  }

  get bodyText() {
    return this.data.body;
  }

  get bodyHTML() {
    return this.data.body;
  }

  get author() {
    return userOf(this.context, this.data.user);
  }

  get authorAssociation() {
    return "NONE";
  }

  get createdAt() {
    return this.data.created_at;
  }

  get updatedAt() {
    return this.data.updated_at;
  }

  get publishedAt() {
    return this.data.created_at;
  }

  get lastEditedAt() {
    return this.data.updated_at === this.data.created_at ? null : this.data.updated_at;
  }

  get url() {
    return this.data.html_url;
  }

  get isMinimized() {
    return false;
  }

  get minimizedReason() {
    return null;
  }

  get includesCreatedEdit() {
    return false;
  }

  get viewerDidAuthor() {
    return false;
  }

  private reactionList() {
    return this.context.gitea.all<GReaction>(
      `repos/${this.repo}/issues/comments/${this.data.id}/reactions`);
  }

  async reactions(args: Page & { content?: string }) {
    return reactionsConnection(this.context, this.id, await this.reactionList(), args);
  }

  async reactionGroups() {
    return reactionGroups(this.context, await this.reactionList());
  }
}

export class PullRequestReview {
  readonly __typename = "PullRequestReview";

  readonly pull: PullRequest;
  readonly data: GReview;

  constructor(pull: PullRequest, data: GReview) {
    this.pull = pull;
    this.data = data;
  }

  get id() {
    return nodeId("PullRequestReview", this.pull.repo, `${this.pull.number}:${this.data.id}`);
  }

  get databaseId() {
    return this.data.id;
  }

  get state() {
    return reviewState(this.data);
  }

  get body() {
    return this.data.body ?? "";
  }

  get bodyText() {
    return this.body;
  }

  get author() {
    return userOf(this.pull.context, this.data.user);
  }

  get authorAssociation() {
    return "NONE";
  }

  get submittedAt() {
    return this.data.submitted_at;
  }

  get createdAt() {
    return this.data.submitted_at;
  }

  get updatedAt() {
    return this.data.updated_at ?? this.data.submitted_at;
  }

  get url() {
    return this.data.html_url;
  }

  get commit() {
    return new Commit(this.pull.context, this.pull.repo, this.data.commit_id);
  }

  get includesCreatedEdit() {
    return false;
  }

  async comments(args: Page) {
    const listed = await this.pull.context.gitea.all<GReviewComment>(
      `repos/${this.pull.repo}/pulls/${this.pull.number}/reviews/${this.data.id}/comments`);
    return connection(listed.map((data) => new ReviewComment(this.pull, data, null)), args);
  }

  reactionGroups() {
    return [];
  }
}

export class ReviewThread {
  readonly __typename = "PullRequestReviewThread";

  readonly pull: PullRequest;
  readonly list: GReviewComment[];

  constructor(pull: PullRequest, list: GReviewComment[]) {
    this.pull = pull;
    this.list = list;
  }

  get id() {
    return nodeId("PullRequestReviewThread", this.pull.repo, `${this.pull.number}:${this.list[0].id}`);
  }

  get isResolved() {
    return Boolean(this.list[0].resolver);
  }

  get resolvedBy() {
    return userOf(this.pull.context, this.list[0].resolver);
  }

  get isOutdated() {
    return !this.list[0].position;
  }

  get isCollapsed() {
    return this.isResolved;
  }

  get path() {
    return this.list[0].path;
  }

  get line() {
    return this.list[0].position || null;
  }

  get originalLine() {
    return this.list[0].original_position || null;
  }

  get diffSide() {
    return "RIGHT";
  }

  get subjectType() {
    return "LINE";
  }

  get viewerCanResolve() {
    return true;
  }

  get viewerCanUnresolve() {
    return true;
  }

  comments(args: Page) {
    const [first] = this.list;
    return connection(this.list.map((data, index) =>
      new ReviewComment(this.pull, data, index ? first : null)), args);
  }
}

export class ReviewComment {
  readonly __typename = "PullRequestReviewComment";

  readonly pull: PullRequest;
  readonly data: GReviewComment;
  readonly parent: GReviewComment | null;

  constructor(pull: PullRequest, data: GReviewComment, parent: GReviewComment | null) {
    this.pull = pull;
    this.data = data;
    this.parent = parent;
  }

  get id() {
    return nodeId("PullRequestReviewComment", this.pull.repo, this.data.id);
  }

  get databaseId() {
    return this.data.id;
  }

  get body() {
    return this.data.body;
  }

  get bodyText() {
    return this.data.body;
  }

  get author() {
    return userOf(this.pull.context, this.data.user);
  }

  get authorAssociation() {
    return "NONE";
  }

  get createdAt() {
    return this.data.created_at;
  }

  get updatedAt() {
    return this.data.updated_at;
  }

  get publishedAt() {
    return this.data.created_at;
  }

  get url() {
    return this.data.html_url;
  }

  get state() {
    return "SUBMITTED";
  }

  get path() {
    return this.data.path;
  }

  get line() {
    return this.data.position || null;
  }

  get originalLine() {
    return this.data.original_position || null;
  }

  get position() {
    return this.data.position || null;
  }

  get originalPosition() {
    return this.data.original_position || 0;
  }

  get diffHunk() {
    return this.data.diff_hunk ?? "";
  }

  get outdated() {
    return !this.data.position;
  }

  get isMinimized() {
    return false;
  }

  get includesCreatedEdit() {
    return false;
  }

  get commit() {
    return new Commit(this.pull.context, this.pull.repo, this.data.commit_id);
  }

  get originalCommit() {
    return new Commit(this.pull.context, this.pull.repo, this.data.original_commit_id);
  }

  get replyTo() {
    return this.parent ? new ReviewComment(this.pull, this.parent, null) : null;
  }

  get pullRequest() {
    return this.pull;
  }

  private reactionList() {
    return this.pull.context.gitea.all<GReaction>(
      `repos/${this.pull.repo}/issues/comments/${this.data.id}/reactions`);
  }

  async reactions(args: Page & { content?: string }) {
    return reactionsConnection(this.pull.context, this.id, await this.reactionList(), args);
  }

  async reactionGroups() {
    return reactionGroups(this.pull.context, await this.reactionList());
  }
}
