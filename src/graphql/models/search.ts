import type { GIssue, GPull } from "../../types.ts";
import { connection, type Page } from "../connection.ts";
import { type Context, ordered } from "../context.ts";
import { Issue, PullRequest } from "./issue.ts";
import { pullIn } from "./repository.ts";

const unquote = (text: string): string => text.replace(/^"|"$/g, "");

/** The free-text terms of a GitHub search, and every value of each `key:value` qualifier. */
export function qualifiers(query: string): { terms: string[]; values: Map<string, string[]> } {
  const values = new Map<string, string[]>();
  const terms: string[] = [];
  for (const token of query.match(/[\w-]+:"[^"]*"|"[^"]*"|\S+/g) ?? []) {
    const qualified = /^(-?[\w-]+):(.+)$/.exec(token);
    if (qualified) values.set(qualified[1], [...values.get(qualified[1]) ?? [], unquote(qualified[2])]);
    else terms.push(unquote(token));
  }
  return { terms, values };
}

/**
 * The issues and pull requests a GitHub search query names, read from the one
 * repository its `repo:` qualifier names. A search across repositories is not
 * supported, as gh only sends one for `gh search`.
 */
export async function search(context: Context, args: Page & { query: string; type: string }) {
  const { terms, values } = qualifiers(args.query);
  const one = (key: string) => values.get(key)?.[0];
  const is = new Set(values.get("is") ?? []);
  const repo = one("repo");
  if (!repo) {
    return { ...connection([], args), issueCount: 0, repositoryCount: 0, userCount: 0,
      codeCount: 0, discussionCount: 0, wikiCount: 0 };
  }
  const state = one("state") ?? (is.has("open") ? "open" : is.has("closed") || is.has("merged") ? "closed" : undefined);
  const labels = values.get("label") ?? [];
  const wantPulls = is.has("pr") || one("type") === "pr";
  const wantIssues = is.has("issue") || one("type") === "issue";

  const issues = wantPulls ? [] : await context.gitea.all<GIssue>(`repos/${repo}/issues`, {
    state: state ?? "all", type: "issues", labels: labels.join(",") || undefined,
    created_by: one("author"), assigned_by: one("assignee"), mentioned_by: one("mentions"),
  });
  const pulls = wantIssues ? [] : await context.gitea.all<GPull>(`repos/${repo}/pulls`,
    { state: state ?? "all" });
  const matches = (item: GIssue | GPull) =>
    labels.every((name) => item.labels.some((label) => label.name.toLowerCase() === name.toLowerCase())) &&
    (!one("author") || item.user.login === one("author")) &&
    (!one("assignee") || (item.assignees ?? []).some((user) => user.login === one("assignee"))) &&
    terms.every((term) => `${item.title}\n${item.body}`.toLowerCase().includes(term.toLowerCase()));
  const wantedPulls = pulls.filter((pull) => matches(pull) &&
    (!is.has("merged") || pullIn(pull, ["MERGED"])) &&
    (!one("head") || pull.head.ref === one("head")) && (!one("base") || pull.base.ref === one("base")));
  const [field, direction] = (one("sort") ?? "created-desc").split("-");
  const order = { field: field === "updated" ? "UPDATED_AT" : "CREATED_AT", direction: direction?.toUpperCase() };
  const nodes = ordered<GIssue | GPull>([...issues.filter(matches), ...wantedPulls], order)
    .map((data) => "head" in data
      ? new PullRequest(context, repo, data) : new Issue(context, repo, data));
  return { ...connection(nodes, args), issueCount: nodes.length, repositoryCount: 0, userCount: 0,
    codeCount: 0, discussionCount: 0, wikiCount: 0 };
}
