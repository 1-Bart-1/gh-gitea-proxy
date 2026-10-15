import { reactionId } from "../../rest/shape.ts";
import type { GLabel, GReaction, GUser } from "../../types.ts";
import { connection, type Page } from "../connection.ts";
import type { Context } from "../context.ts";
import { nodeId } from "../ids.ts";

export class User {
  readonly __typename = "User";

  readonly context: Context;
  readonly data: GUser;

  constructor(context: Context, data: GUser) {
    this.context = context;
    this.data = data;
  }

  get id() {
    return nodeId("User", "", this.data.login);
  }

  get databaseId() {
    return this.data.id;
  }

  get login() {
    return this.data.login;
  }

  get name() {
    return this.data.full_name || null;
  }

  get email() {
    return this.data.email ?? "";
  }

  get url() {
    return this.data.html_url ?? "";
  }

  avatarUrl() {
    return this.data.avatar_url ?? "";
  }

  get isSiteAdmin() {
    return Boolean(this.data.is_admin);
  }

  get resourcePath() {
    return `/${this.data.login}`;
  }
}

/** A `User` for `data`, and null when there is no one. */
export const userOf = (context: Context, data: GUser | null | undefined): User | null =>
  data ? new User(context, data) : null;

export class Label {
  readonly __typename = "Label";

  readonly repo: string;
  readonly data: GLabel;

  constructor(repo: string, data: GLabel) {
    this.repo = repo;
    this.data = data;
  }

  get id() {
    return nodeId("Label", this.repo, this.data.id);
  }

  get name() {
    return this.data.name;
  }

  get color() {
    return this.data.color.replace(/^#/, "");
  }

  get description() {
    return this.data.description || null;
  }

  get isDefault() {
    return false;
  }

  get url() {
    return this.data.url ?? "";
  }

  get createdAt() {
    return null;
  }
}

const CONTENTS: Record<string, string> = {
  "+1": "THUMBS_UP", "-1": "THUMBS_DOWN", laugh: "LAUGH", hooray: "HOORAY",
  confused: "CONFUSED", heart: "HEART", rocket: "ROCKET", eyes: "EYES",
};

/** GitHub's `ReactionContent` enum value for a Gitea reaction. */
export const contentOf = (gitea: string): string => CONTENTS[gitea] ?? gitea.toUpperCase();

/** The Gitea reaction for a GitHub `ReactionContent` enum value. */
export const giteaContent = (content: string): string =>
  Object.entries(CONTENTS).find(([, value]) => value === content)?.[0] ?? content.toLowerCase();

export class Reaction {
  readonly __typename = "Reaction";

  readonly context: Context;
  readonly subject: string;
  readonly data: GReaction;

  constructor(context: Context, subject: string, data: GReaction) {
    this.context = context;
    this.subject = subject;
    this.data = data;
  }

  get id() {
    return nodeId("Reaction", this.subject, `${this.data.user.id}:${this.data.content}`);
  }

  get databaseId() {
    return reactionId(this.data.user.id, this.data.content);
  }

  get content() {
    return contentOf(this.data.content);
  }

  get createdAt() {
    return this.data.created_at;
  }

  get user() {
    return userOf(this.context, this.data.user);
  }
}

/** A `reactions(content:, ...)` connection over what Gitea returned. */
export function reactionsConnection(context: Context, subject: string, all: GReaction[],
  args: Page & { content?: string }) {
  const wanted = args.content ? all.filter((entry) => contentOf(entry.content) === args.content) : all;
  return {
    ...connection(wanted.map((entry) => new Reaction(context, subject, entry)), args),
    viewerHasReacted: false,
  };
}

/** `reactionGroups` over every reaction on a subject. */
export const reactionGroups = (context: Context, all: GReaction[]) =>
  Object.values(CONTENTS).map((content) => {
    const users = all.filter((entry) => contentOf(entry.content) === content);
    return {
      content,
      viewerHasReacted: false,
      users: () => connection(users.map((entry) => new User(context, entry.user))),
      reactors: () => connection(users.map((entry) => new User(context, entry.user))),
    };
  }).filter((group) => group.users().totalCount > 0);

/** An empty connection, for lists Gitea has no equivalent of. */
export const none = (args: Page = {}) => connection([], args);
