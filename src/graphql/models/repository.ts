import type { GIssue, GLabel, GPull, GRelease, GRepo, GUser } from "../../types.ts";
import { connection, type Page } from "../connection.ts";
import { type Context, ordered, repoData } from "../context.ts";
import { nodeId } from "../ids.ts";
import { Commit, Ref, Release } from "./commit.ts";
import { Label, none, User } from "./common.ts";
import { Issue, PullRequest } from "./issue.ts";

type Order = { field?: string; direction?: string };

interface IssueFilter extends Page {
  states?: string[];
  labels?: string[];
  orderBy?: Order;
  filterBy?: { states?: string[]; labels?: string[]; createdBy?: string; assignee?: string;
    mentioned?: string; since?: string };
}

interface PullFilter extends Page {
  states?: string[];
  labels?: string[];
  headRefName?: string;
  baseRefName?: string;
  orderBy?: Order;
}

/** Gitea's `state` query value for a set of GitHub states. */
const giteaState = (states: string[] | undefined): string =>
  !states?.length || states.length > 1 ? "all" : states[0] === "OPEN" ? "open" : "closed";

/** Whether a pull request is in one of the GitHub `states`. */
export const pullIn = (pull: GPull, states: string[] | undefined): boolean =>
  !states?.length || states.includes(pull.merged ? "MERGED" : pull.state.toUpperCase());

export class Repository {
  readonly __typename = "Repository";

  readonly context: Context;
  readonly data: GRepo;

  constructor(context: Context, data: GRepo) {
    this.context = context;
    this.data = data;
  }

  static async load(context: Context, repo: string): Promise<Repository> {
    return new Repository(context, await repoData(context, repo));
  }

  private get full() {
    return this.data.full_name;
  }

  get id() {
    return nodeId("Repository", this.full, this.data.id);
  }

  get databaseId() {
    return this.data.id;
  }

  get name() {
    return this.data.name;
  }

  get nameWithOwner() {
    return this.full;
  }

  get owner() {
    return new User(this.context, this.data.owner);
  }

  get description() {
    return this.data.description || null;
  }

  get url() {
    return this.data.html_url;
  }

  get sshUrl() {
    return this.data.ssh_url ?? "";
  }

  get isPrivate() {
    return this.data.private;
  }

  get visibility() {
    return this.data.private ? "PRIVATE" : "PUBLIC";
  }

  get isFork() {
    return this.data.fork;
  }

  get isArchived() {
    return Boolean(this.data.archived);
  }

  get isInOrganization() {
    return false;
  }

  get hasIssuesEnabled() {
    return this.data.has_issues ?? true;
  }

  get hasWikiEnabled() {
    return false;
  }

  get hasDiscussionsEnabled() {
    return false;
  }

  get hasProjectsEnabled() {
    return false;
  }

  get mergeCommitAllowed() {
    return true;
  }

  get rebaseMergeAllowed() {
    return true;
  }

  get squashMergeAllowed() {
    return true;
  }

  get createdAt() {
    return this.data.created_at;
  }

  get updatedAt() {
    return this.data.updated_at;
  }

  get pushedAt() {
    return this.data.updated_at;
  }

  get viewerPermission() {
    const permissions = this.data.permissions;
    return permissions?.admin ? "ADMIN" : permissions?.push ? "WRITE" : "READ";
  }

  get viewerCanAdminister() {
    return Boolean(this.data.permissions?.admin);
  }

  get parent() {
    return this.data.parent ? new Repository(this.context, this.data.parent) : null;
  }

  get defaultBranchRef() {
    return new Ref(this.context, this.full, `refs/heads/${this.data.default_branch}`);
  }

  async issue({ number }: { number: number }) {
    const found = await this.context.gitea.find<GIssue>(`repos/${this.full}/issues/${number}`);
    return found && !found.pull_request ? new Issue(this.context, this.full, found) : null;
  }

  async pullRequest({ number }: { number: number }) {
    const found = await this.context.gitea.find<GPull>(`repos/${this.full}/pulls/${number}`);
    return found ? new PullRequest(this.context, this.full, found) : null;
  }

  async issueOrPullRequest({ number }: { number: number }) {
    return (await this.pullRequest({ number })) ?? this.issue({ number });
  }

  async issues(args: IssueFilter) {
    const filter = args.filterBy ?? {};
    const states = args.states ?? filter.states;
    const labels = args.labels ?? filter.labels;
    const listed = await this.context.gitea.all<GIssue>(`repos/${this.full}/issues`, {
      state: giteaState(states), type: "issues", labels: labels?.join(","),
      created_by: filter.createdBy, assigned_by: filter.assignee,
      mentioned_by: filter.mentioned, since: filter.since,
    });
    const nodes = ordered(listed, args.orderBy).map((data) => new Issue(this.context, this.full, data));
    return connection(nodes, args);
  }

  async pullRequests(args: PullFilter) {
    const listed = await this.context.gitea.all<GPull>(`repos/${this.full}/pulls`, {
      state: giteaState(args.states?.map((state) => state === "MERGED" ? "CLOSED" : state)),
    });
    const wanted = listed.filter((pull) => pullIn(pull, args.states) &&
      (!args.headRefName || pull.head.ref === args.headRefName) &&
      (!args.baseRefName || pull.base.ref === args.baseRefName) &&
      (!args.labels?.length || args.labels.every((name) =>
        pull.labels.some((label) => label.name === name))));
    const nodes = ordered(wanted, args.orderBy)
      .map((data) => new PullRequest(this.context, this.full, data));
    return connection(nodes, args);
  }

  async label({ name }: { name: string }) {
    const labels = await this.context.gitea.all<GLabel>(`repos/${this.full}/labels`);
    const found = labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
    return found ? new Label(this.full, found) : null;
  }

  async labels(args: Page & { query?: string; orderBy?: Order }) {
    const labels = await this.context.gitea.all<GLabel>(`repos/${this.full}/labels`);
    const wanted = args.query
      ? labels.filter((label) => label.name.toLowerCase().includes(args.query!.toLowerCase()))
      : labels;
    return connection(wanted.map((label) => new Label(this.full, label)), args);
  }

  async assignableUsers(args: Page & { query?: string }) {
    const users = await this.context.gitea.all<GUser>(`repos/${this.full}/assignees`);
    const wanted = args.query
      ? users.filter((user) => user.login.toLowerCase().includes(args.query!.toLowerCase()))
      : users;
    return connection(wanted.map((user) => new User(this.context, user)), args);
  }

  async mentionableUsers(args: Page & { query?: string }) {
    return this.assignableUsers(args);
  }

  async ref({ qualifiedName }: { qualifiedName: string }) {
    const name = qualifiedName.startsWith("refs/") ? qualifiedName : `refs/heads/${qualifiedName}`;
    const found = await this.context.gitea.find(`repos/${this.full}/git/refs/${
      name.replace(/^refs\//, "")}`);
    return found ? new Ref(this.context, this.full, name) : null;
  }

  async object({ expression, oid }: { expression?: string; oid?: string }) {
    const sha = oid ?? expression ?? "";
    const found = await this.context.gitea.find(`repos/${this.full}/git/commits/${sha}`);
    return found ? new Commit(this.context, this.full, sha) : null;
  }

  async releases(args: Page & { orderBy?: Order }) {
    const listed = await this.context.gitea.all<GRelease>(`repos/${this.full}/releases`);
    const nodes = ordered(listed, args.orderBy, "CREATED_AT", "DESC")
      .map((data) => new Release(this.context, this.full, data));
    return connection(nodes, args);
  }

  async latestRelease() {
    const found = await this.context.gitea.find<GRelease>(`repos/${this.full}/releases/latest`);
    return found ? new Release(this.context, this.full, found) : null;
  }

  async release({ tagName }: { tagName: string }) {
    const found = await this.context.gitea.find<GRelease>(
      `repos/${this.full}/releases/tags/${encodeURIComponent(tagName)}`);
    return found ? new Release(this.context, this.full, found) : null;
  }

  commitComments(args: Page) {
    return none(args);
  }

  milestones(args: Page) {
    return none(args);
  }

  projects(args: Page) {
    return none(args);
  }

  projectsV2(args: Page) {
    return none(args);
  }
}
