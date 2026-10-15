import type { Gitea } from "../gitea.ts";
import type { GRepo, GUser } from "../types.ts";

/** What every resolver in one GraphQL request shares. */
export interface Context {
  gitea: Gitea;
  /** `https://<proxy host>` as the client addressed it. */
  origin: string;
}

export const repoData = (context: Context, repo: string): Promise<GRepo> =>
  context.gitea.get<GRepo>(`repos/${repo}`);

export const viewerData = (context: Context): Promise<GUser> => context.gitea.get<GUser>("user");

/** `owner/name` as one string, the form Gitea's paths take. */
export const fullName = (owner: string, name: string): string => `${owner}/${name}`;

type Order = { field?: string; direction?: string } | undefined;

const ORDER_FIELDS: Record<string, string> = {
  CREATED_AT: "created_at", UPDATED_AT: "updated_at",
};

/** `items` sorted as a GitHub `orderBy` asks, oldest first when none is given. */
export function ordered<T extends Record<string, any>>(items: T[], order: Order,
  fallback = "CREATED_AT", direction = "ASC"): T[] {
  const key = ORDER_FIELDS[order?.field ?? fallback] ?? "created_at";
  const sign = (order?.direction ?? direction) === "DESC" ? -1 : 1;
  return [...items].sort((one, other) =>
    sign * String(one[key]).localeCompare(String(other[key])));
}
