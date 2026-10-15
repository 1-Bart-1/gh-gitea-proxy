import { combined, detailsUrl, jobsOn, jobState, statusesOn } from "../../checks.ts";
import type { GActionJob, GCommit, GPull, GRelease, GStatus } from "../../types.ts";
import { connection, type Page } from "../connection.ts";
import { type Context, repoData } from "../context.ts";
import { nodeId } from "../ids.ts";
import { none, userOf } from "./common.ts";
import { PullRequest } from "./issue.ts";

/** A person on a commit, with the account their email belongs to when Gitea knows it. */
const gitActor = (context: Context, person: GCommit["commit"]["author"], account: GCommit["author"]) => ({
  name: person.name, email: person.email, date: person.date,
  user: userOf(context, account),
});

export class Commit {
  readonly __typename = "Commit";

  readonly context: Context;
  readonly repo: string;
  readonly sha: string;
  private readonly known?: GCommit;

  constructor(context: Context, repo: string, sha: string, known?: GCommit) {
    this.context = context;
    this.repo = repo;
    this.sha = sha;
    this.known = known;
  }

  private async data(): Promise<GCommit> {
    return this.known ?? this.context.gitea.get<GCommit>(`repos/${this.repo}/git/commits/${this.sha}`,
      { stat: false, files: false });
  }

  get id() {
    return nodeId("Commit", this.repo, this.sha);
  }

  async oid() {
    return this.sha.length === 40 ? this.sha : (await this.data()).sha;
  }

  async abbreviatedOid() {
    return (await this.oid()).slice(0, 7);
  }

  async message() {
    return (await this.data()).commit.message;
  }

  async messageHeadline() {
    return (await this.message()).split("\n")[0];
  }

  async messageBody() {
    return (await this.message()).split("\n").slice(1).join("\n").trim();
  }

  async author() {
    const data = await this.data();
    return gitActor(this.context, data.commit.author, data.author);
  }

  async committer() {
    const data = await this.data();
    return gitActor(this.context, data.commit.committer, data.committer);
  }

  async authoredDate() {
    return (await this.data()).commit.author.date;
  }

  async committedDate() {
    return (await this.data()).commit.committer.date;
  }

  async url() {
    return (await this.data()).html_url ?? "";
  }

  async authors(args: Page) {
    return connection([await this.author()], args);
  }

  async statusCheckRollup() {
    return StatusCheckRollup.load(this.context, this.repo, await this.oid());
  }

  async status() {
    return StatusCheckRollup.load(this.context, this.repo, await this.oid());
  }

  /** Commits reachable from this one, newest first, as `git log` lists them. */
  async history(args: Page & { since?: string; until?: string; path?: string }) {
    const listed = await this.context.gitea.all<GCommit>(`repos/${this.repo}/commits`, {
      sha: await this.oid(), since: args.since, until: args.until, path: args.path,
      stat: false, files: false, verification: false,
    });
    return connection(listed.map((data) => new Commit(this.context, this.repo, data.sha, data)), args);
  }

  /** The pull request that merged this commit, or else the open ones it heads. */
  async associatedPullRequests(args: Page) {
    const oid = await this.oid();
    const merged = await this.context.gitea.find<GPull>(`repos/${this.repo}/commits/${oid}/pull`);
    const pulls = merged ? [merged] : (await this.context.gitea.all<GPull>(`repos/${this.repo}/pulls`,
      { state: "open" })).filter((pull) => pull.head.sha === oid);
    return connection(pulls.map((pull) => new PullRequest(this.context, this.repo, pull)), args);
  }

  /** The file at `path` in this commit's tree, as a tree entry holding its blob. */
  async file({ path }: { path: string }) {
    const response = await this.context.gitea.raw("GET", `repos/${this.repo}/raw/${
      path.split("/").map(encodeURIComponent).join("/")}`, { ref: await this.oid() }, undefined, "*/*")
      .catch(() => undefined);
    if (!response) return null;
    const text = await response.text();
    return {
      name: path.replace(/^.*\//, ""), path, type: "blob",
      object: { __typename: "Blob", text, isTruncated: false, isBinary: false, byteSize: text.length },
    };
  }

  checkSuites(args: Page) {
    return none(args);
  }
}

export class Ref {
  readonly __typename = "Ref";

  readonly context: Context;
  readonly repo: string;
  readonly qualifiedName: string;

  constructor(context: Context, repo: string, qualifiedName: string) {
    this.context = context;
    this.repo = repo;
    this.qualifiedName = qualifiedName;
  }

  get id() {
    return nodeId("Ref", this.repo, this.qualifiedName);
  }

  get name() {
    return this.qualifiedName.replace(/^refs\/(heads|tags)\//, "");
  }

  get prefix() {
    return this.qualifiedName.replace(/[^/]+$/, "");
  }

  async target() {
    const found = await this.context.gitea.get<{ object: { sha: string } } | { object: { sha: string } }[]>(
      `repos/${this.repo}/git/${this.qualifiedName}`);
    const ref = Array.isArray(found) ? found[0] : found;
    return new Commit(this.context, this.repo, ref.object.sha);
  }

  async associatedPullRequests(args: Page & { states?: string[] }) {
    const pulls = await this.context.gitea.all<GPull>(`repos/${this.repo}/pulls`, { state: "open" });
    const nodes = pulls.filter((pull) => pull.head.ref === this.name)
      .map((pull) => new PullRequest(this.context, this.repo, pull));
    return connection(nodes, args);
  }
}

const STATES: Record<string, string> = {
  success: "SUCCESS", pending: "PENDING", failure: "FAILURE", error: "ERROR", warning: "SUCCESS",
};

export class StatusCheckRollup {
  readonly __typename = "StatusCheckRollup";

  readonly context: Context;
  readonly repo: string;
  readonly sha: string;
  readonly runs: CheckRun[];
  readonly statuses: StatusContext[];

  private constructor(context: Context, repo: string, sha: string, runs: CheckRun[],
    statuses: StatusContext[]) {
    this.context = context;
    this.repo = repo;
    this.sha = sha;
    this.runs = runs;
    this.statuses = statuses;
  }

  /** What ran on a commit, and null for a commit nothing ran on, as GitHub answers. */
  static async load(context: Context, repo: string, sha: string) {
    const [data, jobs, statuses] = await Promise.all([repoData(context, repo),
      jobsOn(context.gitea, repo, sha), statusesOn(context.gitea, repo, sha)]);
    if (!jobs.length && !statuses.length) return null;
    return new StatusCheckRollup(context, repo, sha,
      jobs.map((job) => new CheckRun(repo, data.html_url, job)),
      statuses.map((status) => new StatusContext(repo, status)));
  }

  get id() {
    return nodeId("StatusCheckRollup", this.repo, this.sha);
  }

  get state() {
    return combined([...this.runs.map((run) => jobState(run.data)),
      ...this.statuses.map((status) => status.data.status === "warning" ? "success" : status.data.status)])
      .toUpperCase();
  }

  get commit() {
    return new Commit(this.context, this.repo, this.sha);
  }

  contexts(args: Page) {
    const counts = (nodes: { state: string }[]) => Object.entries(Object.groupBy(nodes, (node) => node.state))
      .map(([state, list]) => ({ state, count: list?.length ?? 0 }));
    return {
      ...connection<CheckRun | StatusContext>([...this.runs, ...this.statuses], args),
      checkRunCount: this.runs.length, statusContextCount: this.statuses.length,
      checkRunCountsByState: counts(this.runs.map((run) => ({ state: run.conclusion ?? run.status }))),
      statusContextCountsByState: counts(this.statuses),
    };
  }
}

/** A Gitea Actions job. */
export class CheckRun {
  readonly __typename = "CheckRun";

  readonly repo: string;
  readonly repoHtml: string;
  readonly data: GActionJob;

  constructor(repo: string, repoHtml: string, data: GActionJob) {
    this.repo = repo;
    this.repoHtml = repoHtml;
    this.data = data;
  }

  get id() {
    return nodeId("CheckRun", this.repo, this.data.id);
  }

  get databaseId() {
    return this.data.id;
  }

  get name() {
    return this.data.name;
  }

  get status() {
    return this.data.status.toUpperCase();
  }

  get conclusion() {
    return this.data.status === "completed" && this.data.conclusion ? this.data.conclusion.toUpperCase() : null;
  }

  get detailsUrl() {
    return detailsUrl(this.repoHtml, this.data);
  }

  get url() {
    return this.data.html_url;
  }

  get permalink() {
    return this.data.html_url;
  }

  get startedAt() {
    return this.data.started_at ?? null;
  }

  get completedAt() {
    return this.data.completed_at ?? null;
  }

  get title() {
    return null;
  }

  get summary() {
    return null;
  }

  isRequired() {
    return false;
  }

  get checkSuite() {
    return { workflowRun: { workflow: { name: "" }, event: "push", runNumber: this.data.run_id } };
  }
}

export class StatusContext {
  readonly __typename = "StatusContext";

  readonly repo: string;
  readonly data: GStatus;

  constructor(repo: string, data: GStatus) {
    this.repo = repo;
    this.data = data;
  }

  get id() {
    return nodeId("StatusContext", this.repo, this.data.id);
  }

  get context() {
    return this.data.context;
  }

  get state() {
    return STATES[this.data.status] ?? "PENDING";
  }

  get targetUrl() {
    return this.data.target_url || null;
  }

  get description() {
    return this.data.description || null;
  }

  get createdAt() {
    return this.data.created_at;
  }

  get avatarUrl() {
    return null;
  }

  isRequired() {
    return false;
  }
}

export class Release {
  readonly __typename = "Release";

  readonly context: Context;
  readonly repo: string;
  readonly data: GRelease;

  constructor(context: Context, repo: string, data: GRelease) {
    this.context = context;
    this.repo = repo;
    this.data = data;
  }

  get id() {
    return nodeId("Release", this.repo, this.data.id);
  }

  get databaseId() {
    return this.data.id;
  }

  get name() {
    return this.data.name || this.data.tag_name;
  }

  get tagName() {
    return this.data.tag_name;
  }

  get description() {
    return this.data.body;
  }

  get url() {
    return this.data.html_url;
  }

  get isDraft() {
    return this.data.draft;
  }

  get isPrerelease() {
    return this.data.prerelease;
  }

  get immutable() {
    return false;
  }

  async isLatest() {
    const latest = await this.context.gitea.find<GRelease>(`repos/${this.repo}/releases/latest`);
    return latest?.id === this.data.id;
  }

  get createdAt() {
    return this.data.created_at;
  }

  get publishedAt() {
    return this.data.published_at;
  }

  get author() {
    return userOf(this.context, this.data.author);
  }

  get tag() {
    return { name: this.data.tag_name, prefix: "refs/tags/", target: null };
  }

  releaseAssets(args: Page) {
    return none(args);
  }
}
