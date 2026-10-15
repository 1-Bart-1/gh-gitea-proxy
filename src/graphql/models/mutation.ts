import { GraphQLError } from "graphql";
import { draftTitle } from "../../rest/shape.ts";
import type { GComment, GIssue, GPull } from "../../types.ts";
import type { Context } from "../context.ts";
import { decodeId, nodeId } from "../ids.ts";
import { giteaContent } from "./common.ts";
import { Issue, IssueComment, PullRequest, ReviewThread } from "./issue.ts";
import { nodeFor } from "./root.ts";

type Input = { input: Record<string, any> };

/** The repository and number an issue or pull request ID names. */
function threadOf(id: string): { repo: string; number: string } {
  const { type, repo, key } = decodeId(id);
  if (type !== "Issue" && type !== "PullRequest") throw new GraphQLError(`not an issue: ${id}`);
  return { repo, number: key };
}

/** The repository a repository ID names. */
function repoOf(id: string): string {
  const { type, repo } = decodeId(id);
  if (type !== "Repository") throw new GraphQLError(`not a repository: ${id}`);
  return repo;
}

/** Gitea label IDs from GitHub label node IDs. */
const labelIds = (ids: string[] | null = []): number[] =>
  (ids ?? []).map((id) => Number(decodeId(id).key));

/** Gitea logins from GitHub user node IDs. */
const logins = (ids: string[] | null = []): string[] => (ids ?? []).map((id) => decodeId(id).key);

export class Mutation {
  readonly context: Context;

  constructor(context: Context) {
    this.context = context;
  }

  private get gitea() {
    return this.context.gitea;
  }

  /** The issue or pull request at `id` read again after a write. */
  private async reread(id: string) {
    this.gitea.forget();
    return nodeFor(this.context, id) as Promise<Issue | PullRequest>;
  }

  async createIssue({ input }: Input) {
    const repo = repoOf(input.repositoryId);
    const data = await this.gitea.call<GIssue>("POST", `repos/${repo}/issues`, undefined, {
      title: input.title, body: input.body ?? "", labels: labelIds(input.labelIds),
      assignees: logins(input.assigneeIds),
    });
    return { issue: new Issue(this.context, repo, data) };
  }

  /** Edit an issue or pull request's own fields, then its labels and assignees. */
  private async editThread(id: string, input: Record<string, any>) {
    const { repo, number } = threadOf(id);
    const fields: Record<string, unknown> = {};
    if (input.body !== undefined) fields.body = input.body;
    if (input.state) fields.state = input.state.toLowerCase();
    if (input.baseRefName) fields.base = input.baseRefName;
    if (input.title !== undefined) {
      const pull = await this.gitea.find<GPull>(`repos/${repo}/pulls/${number}`);
      fields.title = draftTitle(input.title, Boolean(pull?.draft));
    }
    if (input.assigneeIds) fields.assignees = logins(input.assigneeIds);
    if (Object.keys(fields).length) {
      await this.gitea.call("PATCH", `repos/${repo}/issues/${number}`, undefined, fields);
    }
    if (input.labelIds) {
      await this.gitea.call("PUT", `repos/${repo}/issues/${number}/labels`, undefined,
        { labels: labelIds(input.labelIds) });
    }
    return this.reread(id);
  }

  async updateIssue({ input }: Input) {
    return { issue: await this.editThread(input.id, input) };
  }

  async updatePullRequest({ input }: Input) {
    return { pullRequest: await this.editThread(input.pullRequestId, input) };
  }

  async closeIssue({ input }: Input) {
    return { issue: await this.editThread(input.issueId, { state: "CLOSED" }) };
  }

  async reopenIssue({ input }: Input) {
    return { issue: await this.editThread(input.issueId, { state: "OPEN" }) };
  }

  async closePullRequest({ input }: Input) {
    return { pullRequest: await this.editThread(input.pullRequestId, { state: "CLOSED" }) };
  }

  async reopenPullRequest({ input }: Input) {
    return { pullRequest: await this.editThread(input.pullRequestId, { state: "OPEN" }) };
  }

  async addComment({ input }: Input) {
    const { repo, number } = threadOf(input.subjectId);
    const data = await this.gitea.call<GComment>("POST", `repos/${repo}/issues/${number}/comments`,
      undefined, { body: input.body });
    const node = new IssueComment(this.context, repo, data);
    return { commentEdge: { node, cursor: "" }, timelineEdge: { node }, subject: await this.reread(input.subjectId) };
  }

  async updateIssueComment({ input }: Input) {
    const { repo, key } = decodeId(input.id);
    const data = await this.gitea.call<GComment>("PATCH", `repos/${repo}/issues/comments/${key}`,
      undefined, { body: input.body });
    return { issueComment: new IssueComment(this.context, repo, data) };
  }

  async deleteIssueComment({ input }: Input) {
    const { repo, key } = decodeId(input.id);
    await this.gitea.call("DELETE", `repos/${repo}/issues/comments/${key}`);
    return { clientMutationId: input.clientMutationId ?? null };
  }

  async addLabelsToLabelable({ input }: Input) {
    const { repo, number } = threadOf(input.labelableId);
    await this.gitea.call("POST", `repos/${repo}/issues/${number}/labels`, undefined,
      { labels: labelIds(input.labelIds) });
    return { labelable: await this.reread(input.labelableId) };
  }

  async removeLabelsFromLabelable({ input }: Input) {
    const { repo, number } = threadOf(input.labelableId);
    for (const label of labelIds(input.labelIds)) {
      await this.gitea.call("DELETE", `repos/${repo}/issues/${number}/labels/${label}`);
    }
    return { labelable: await this.reread(input.labelableId) };
  }

  /** Set the assignees of a thread to its current ones with `add` added and `remove` removed. */
  private async reassign(id: string, add: string[], remove: string[]) {
    const { repo, number } = threadOf(id);
    const data = await this.gitea.get<GIssue>(`repos/${repo}/issues/${number}`);
    const current = (data.assignees ?? []).map((user) => user.login);
    const assignees = [...new Set([...current, ...add])].filter((login) => !remove.includes(login));
    return this.editThread(id, { assigneeIds: assignees.map((login) => nodeId("User", "", login)) });
  }

  async addAssigneesToAssignable({ input }: Input) {
    return { assignable: await this.reassign(input.assignableId, logins(input.assigneeIds), []) };
  }

  async removeAssigneesFromAssignable({ input }: Input) {
    return { assignable: await this.reassign(input.assignableId, [], logins(input.assigneeIds)) };
  }

  async createPullRequest({ input }: Input) {
    const repo = repoOf(input.repositoryId);
    const forked = input.headRepositoryId && input.headRepositoryId !== input.repositoryId;
    const head = forked
      ? `${repoOf(input.headRepositoryId).split("/")[0]}:${input.headRefName}` : input.headRefName;
    const data = await this.gitea.call<GPull>("POST", `repos/${repo}/pulls`, undefined, {
      base: input.baseRefName, head, body: input.body ?? "",
      title: draftTitle(input.title, Boolean(input.draft)),
    });
    return { pullRequest: new PullRequest(this.context, repo, data) };
  }

  /** Put the draft marker on a pull request's title, or take it off. */
  private async setDraft(id: string, draft: boolean) {
    const { repo, number } = threadOf(id);
    const pull = await this.gitea.get<GPull>(`repos/${repo}/pulls/${number}`);
    await this.gitea.call("PATCH", `repos/${repo}/pulls/${number}`, undefined,
      { title: draftTitle(pull.title, draft) });
    return { pullRequest: await this.reread(id) };
  }

  markPullRequestReadyForReview({ input }: Input) {
    return this.setDraft(input.pullRequestId, false);
  }

  convertPullRequestToDraft({ input }: Input) {
    return this.setDraft(input.pullRequestId, true);
  }

  async mergePullRequest({ input }: Input) {
    const { repo, number } = threadOf(input.pullRequestId);
    const methods: Record<string, string> = { MERGE: "merge", SQUASH: "squash", REBASE: "rebase" };
    await this.gitea.call("POST", `repos/${repo}/pulls/${number}/merge`, undefined, {
      Do: methods[input.mergeMethod ?? "MERGE"] ?? "merge",
      MergeTitleField: input.commitHeadline, MergeMessageField: input.commitBody,
      head_commit_id: input.expectedHeadOid,
    });
    return { pullRequest: await this.reread(input.pullRequestId) };
  }

  async requestReviews({ input }: Input) {
    const { repo, number } = threadOf(input.pullRequestId);
    await this.gitea.call("POST", `repos/${repo}/pulls/${number}/requested_reviewers`, undefined,
      { reviewers: logins(input.userIds) });
    return { pullRequest: await this.reread(input.pullRequestId) };
  }

  /** Mark the first comment of a thread resolved or not, which resolves the thread on Gitea. */
  private async resolve(threadId: string, resolved: boolean) {
    const thread = await nodeFor(this.context, threadId) as ReviewThread | null;
    if (!thread) throw new GraphQLError(`no such review thread: ${threadId}`);
    const verb = resolved ? "resolve" : "unresolve";
    await this.gitea.call("POST", `repos/${thread.pull.repo}/pulls/comments/${thread.list[0].id}/${verb}`);
    this.gitea.forget();
    return { thread: await nodeFor(this.context, threadId) };
  }

  resolveReviewThread({ input }: Input) {
    return this.resolve(input.threadId, true);
  }

  unresolveReviewThread({ input }: Input) {
    return this.resolve(input.threadId, false);
  }

  /** React to an issue, a pull request or a comment on either. */
  private async react(subjectId: string, content: string, method: "POST" | "DELETE") {
    const { type, repo, key } = decodeId(subjectId);
    const path = type === "Issue" || type === "PullRequest"
      ? `repos/${repo}/issues/${key}/reactions` : `repos/${repo}/issues/comments/${key}/reactions`;
    await this.gitea.call(method, path, undefined, { content: giteaContent(content) });
    this.gitea.forget();
    const subject = await nodeFor(this.context, subjectId);
    return { reaction: { content, user: null }, subject };
  }

  addReaction({ input }: Input) {
    return this.react(input.subjectId, input.content, "POST");
  }

  removeReaction({ input }: Input) {
    return this.react(input.subjectId, input.content, "DELETE");
  }
}

