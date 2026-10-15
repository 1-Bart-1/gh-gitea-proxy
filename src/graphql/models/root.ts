import type { GComment, GIssue, GLabel, GPull, GRepo, GUser } from "../../types.ts";
import { type Context, fullName, viewerData } from "../context.ts";
import { decodeId } from "../ids.ts";
import { Label, User } from "./common.ts";
import { Issue, IssueComment, PullRequest } from "./issue.ts";
import { Repository } from "./repository.ts";
import { search } from "./search.ts";

/** The object a global node ID names, and null when it is gone. */
export async function nodeFor(context: Context, id: string): Promise<unknown> {
  const { type, repo, key } = decodeId(id);
  const { gitea } = context;
  switch (type) {
    case "Repository": {
      const data = await gitea.find<GRepo>(`repos/${repo}`);
      return data ? new Repository(context, data) : null;
    }
    case "Issue":
    case "PullRequest": {
      const pull = await gitea.find<GPull>(`repos/${repo}/pulls/${key}`);
      if (pull) return new PullRequest(context, repo, pull);
      const issue = await gitea.find<GIssue>(`repos/${repo}/issues/${key}`);
      return issue ? new Issue(context, repo, issue) : null;
    }
    case "IssueComment": {
      const data = await gitea.find<GComment>(`repos/${repo}/issues/comments/${key}`);
      return data ? new IssueComment(context, repo, data) : null;
    }
    case "Label": {
      const labels = await gitea.all<GLabel>(`repos/${repo}/labels`);
      const data = labels.find((label) => String(label.id) === key);
      return data ? new Label(repo, data) : null;
    }
    case "User": {
      const data = await gitea.find<GUser>(`users/${key}`);
      return data ? new User(context, data) : null;
    }
    case "PullRequestReviewThread": {
      const [number, first] = key.split(":");
      const pull = await gitea.find<GPull>(`repos/${repo}/pulls/${number}`);
      if (!pull) return null;
      const threads = await new PullRequest(context, repo, pull).reviewThreads({});
      return threads.nodes.find((thread) => String(thread.list[0].id) === first) ?? null;
    }
    default:
      return null;
  }
}

export class Query {
  readonly context: Context;

  constructor(context: Context) {
    this.context = context;
  }

  async viewer() {
    return new User(this.context, await viewerData(this.context));
  }

  async repository({ owner, name }: { owner: string; name: string }) {
    const data = await this.context.gitea.find<GRepo>(`repos/${fullName(owner, name)}`);
    return data ? new Repository(this.context, data) : null;
  }

  async user({ login }: { login: string }) {
    const data = await this.context.gitea.find<GUser>(`users/${login}`);
    return data ? new User(this.context, data) : null;
  }

  async repositoryOwner({ login }: { login: string }) {
    return this.user({ login });
  }

  node({ id }: { id: string }) {
    return nodeFor(this.context, id);
  }

  nodes({ ids }: { ids: string[] }) {
    return Promise.all(ids.map((id) => nodeFor(this.context, id)));
  }

  search(args: Parameters<typeof search>[1]) {
    return search(this.context, args);
  }

  /** Gitea meters nothing, so every budget is whole. */
  rateLimit() {
    return {
      limit: 5000, cost: 1, remaining: 5000, used: 0, nodeCount: 0,
      resetAt: new Date(Date.now() + 3600_000).toISOString(),
    };
  }
}
