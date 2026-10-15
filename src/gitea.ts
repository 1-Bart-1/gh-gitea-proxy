/**
 * A Gitea REST client for one request's caller: every call carries the token
 * the gh client sent, so the proxy holds no credentials of its own.
 */

export class GiteaError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(status: number, path: string, body: string) {
    super(`gitea ${status} on ${path}: ${body.slice(0, 300)}`);
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export type Query = Record<string, string | number | boolean | string[] | undefined>;

const PAGE_LIMIT = 50;

export class Gitea {
  /** GET responses already fetched while answering this request. */
  private readonly memo = new Map<string, Promise<unknown>>();

  readonly base: string;
  readonly authorization: string | undefined;

  constructor(base: string, authorization: string | undefined) {
    this.base = base;
    this.authorization = authorization;
  }

  /** The API URL of `path` under `/api/v1`, with `query` encoded. */
  url(path: string, query: Query = {}): string {
    const url = new URL(`${this.base}/api/v1/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, item));
      else url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** The raw response to one call, throwing `GiteaError` on any non-2xx. */
  async raw(method: string, path: string, query: Query = {}, body?: unknown,
    accept = "application/json"): Promise<Response> {
    const headers: Record<string, string> = { accept };
    if (this.authorization) headers.authorization = this.authorization;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(this.url(path, query), {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new GiteaError(response.status, path, await response.text());
    return response;
  }

  /** The parsed JSON of one call, and `undefined` for an empty body. */
  async call<T>(method: string, path: string, query: Query = {}, body?: unknown): Promise<T> {
    const text = await (await this.raw(method, path, query, body)).text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** One GET, fetched at most once per proxied request. */
  get<T>(path: string, query: Query = {}): Promise<T> {
    const key = this.url(path, query);
    if (!this.memo.has(key)) this.memo.set(key, this.call<T>("GET", path, query));
    return this.memo.get(key) as Promise<T>;
  }

  /** A GET that answers `undefined` instead of throwing on a 404. */
  async find<T>(path: string, query: Query = {}): Promise<T | undefined> {
    try {
      return await this.get<T>(path, query);
    } catch (error) {
      if (error instanceof GiteaError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Every page of a list endpoint, read until a short page. */
  all<T>(path: string, query: Query = {}): Promise<T[]> {
    const key = `all:${this.url(path, query)}`;
    if (!this.memo.has(key)) this.memo.set(key, this.pages<T>(path, query));
    return this.memo.get(key) as Promise<T[]>;
  }

  private async pages<T>(path: string, query: Query): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.call<T[]>("GET", path, { ...query, page, limit: PAGE_LIMIT });
      items.push(...(batch ?? []));
      if (!batch || batch.length < PAGE_LIMIT) return items;
    }
  }

  /** Forget what has been read, after a write that changes it. */
  forget(): void {
    this.memo.clear();
  }
}
