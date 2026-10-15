import type { Gitea } from "../gitea.ts";

/** What a REST handler is given: the caller's Gitea client and the request. */
export interface RestRequest {
  gitea: Gitea;
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  headers: Record<string, string | string[] | undefined>;
  /** `https://<proxy host>` as the client addressed it. */
  origin: string;
}

export interface RestResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Sent as is instead of `body` serialised as JSON. */
  raw?: string;
}

/** A response with a status, headers or a raw body; a handler returns anything else as the JSON body. */
export class Reply {
  readonly response: RestResponse;

  constructor(response: RestResponse) {
    this.response = response;
  }
}

export const reply = (response: RestResponse): Reply => new Reply(response);

export type Handler = (request: RestRequest) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: Handler;
}

const routes: Route[] = [];

/**
 * Register `handler` for `method` on a GitHub path template such as
 * `repos/:owner/:repo/issues/:number`. A trailing `*name` captures the rest.
 */
export function route(method: string, template: string, handler: Handler): void {
  const names: string[] = [];
  const source = template.split("/").map((part) => {
    if (part.startsWith(":")) {
      names.push(part.slice(1));
      return "([^/]+)";
    }
    if (part.startsWith("*")) {
      names.push(part.slice(1));
      return "(.+)";
    }
    return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  routes.push({ method, pattern: new RegExp(`^${source}$`), names, handler });
}

/** The handler and path parameters for a request, or undefined when none matches. */
export function match(method: string, path: string):
  { handler: Handler; params: Record<string, string> } | undefined {
  for (const entry of routes) {
    if (entry.method !== method) continue;
    const found = entry.pattern.exec(path);
    if (!found) continue;
    const params = Object.fromEntries(entry.names.map((name, index) =>
      [name, decodeURIComponent(found[index + 1])]));
    return { handler: entry.handler, params };
  }
  return undefined;
}

/**
 * One GitHub-style page of `items`, with the `Link` header `gh --paginate`
 * follows to the next one.
 */
export function paged<T>(request: RestRequest, path: string, items: T[]): Reply {
  const perPage = Math.min(Number(request.query.get("per_page") ?? 30) || 30, 100);
  const page = Math.max(Number(request.query.get("page") ?? 1) || 1, 1);
  const body = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  const last = Math.max(Math.ceil(items.length / perPage), 1);
  if (page < last) {
    const at = (number: number) => {
      const query = new URLSearchParams(request.query);
      query.set("page", String(number));
      query.set("per_page", String(perPage));
      return `<${request.origin}/api/v3/${path}?${query}>`;
    };
    headers.link = `${at(page + 1)}; rel="next", ${at(last)}; rel="last"`;
  }
  return reply({ body, headers });
}

/** The value of a request field, from the query string or the JSON body. */
export function field(request: RestRequest, name: string): string | undefined {
  return request.query.get(name) ?? (request.body?.[name] === undefined
    ? undefined : String(request.body[name]));
}

export class RestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
