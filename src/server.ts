/**
 * The HTTP front: GitHub Enterprise's `/api/v3` and `/api/graphql` answered
 * from Gitea, and every other path (git over HTTP, web pages) passed through.
 */
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { Readable } from "node:stream";
import { Gitea, GiteaError } from "./gitea.ts";
import { answer } from "./graphql/handler.ts";
import "./rest/index.ts";
import { match, Reply, RestError, type RestResponse } from "./rest/router.ts";

export interface Options {
  /** Gitea's base URL as the proxy reaches it, without `/api/v1`. */
  gitea: string;
  /** The origin gh uses, `https://<host>`; taken from each request when unset. */
  publicUrl?: string;
  tls?: { key: string; cert: string };
  log?: (line: string) => void;
}

/** Headers gh checks on every response: the token's scopes and the rate limit. */
const GITHUB_HEADERS = {
  "x-oauth-scopes": "repo, read:org, workflow, gist",
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": "5000",
  "x-ratelimit-used": "0",
  "x-github-media-type": "github.v3",
};

const read = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/** `token X` or `bearer X` from gh, as Gitea takes it. */
const authorization = (request: IncomingMessage): string | undefined => {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const [scheme, ...rest] = header.split(" ");
  return /^(token|bearer)$/i.test(scheme) ? `token ${rest.join(" ")}` : header;
};

function send(response: ServerResponse, status: number, body: unknown,
  headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, {
    ...GITHUB_HEADERS, "content-type": typeof body === "string" ? "text/plain; charset=utf-8"
      : "application/json; charset=utf-8", ...headers,
  });
  response.end(text);
}

async function rest(options: Options, gitea: Gitea, origin: string, request: IncomingMessage,
  response: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname.replace(/^\/api\/v3\/?/, "").replace(/\/$/, "");
  const method = request.method ?? "GET";
  const found = match(method, path);
  if (!found) {
    options.log?.(`unsupported REST ${method} /${path}`);
    send(response, 404, { message: `gh-gitea-proxy does not implement ${method} /${path}` });
    return;
  }
  const raw = await read(request);
  let body: unknown = {};
  if (raw.length) {
    try {
      body = JSON.parse(raw.toString());
    } catch {
      body = raw;
    }
  }
  const result = await found.handler({
    gitea, method, params: found.params, query: url.searchParams, body,
    headers: request.headers, origin,
  });
  const shaped: RestResponse = result instanceof Reply ? result.response : { body: result };
  const status = shaped.status ?? (shaped.body === undefined && shaped.raw === undefined ? 204 : 200);
  if (shaped.raw !== undefined) send(response, status, shaped.raw, shaped.headers);
  else if (status === 204 || status === 304) {
    response.writeHead(status, { ...GITHUB_HEADERS, ...shaped.headers });
    response.end();
  } else send(response, status, shaped.body ?? null, shaped.headers);
}

/** Pass a request on to Gitea unchanged and stream its answer back. */
async function passThrough(options: Options, request: IncomingMessage, response: ServerResponse,
  url: URL): Promise<void> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name === "host" || name === "connection") continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const hasBody = !["GET", "HEAD"].includes(request.method ?? "GET");
  const upstream = await fetch(`${options.gitea}${url.pathname}${url.search}`, {
    method: request.method, headers, redirect: "manual",
    body: hasBody ? Readable.toWeb(request) as ReadableStream : undefined,
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
  const out: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!["content-encoding", "content-length", "transfer-encoding"].includes(name)) out[name] = value;
  });
  response.writeHead(upstream.status, out);
  if (upstream.body) Readable.fromWeb(upstream.body as any).pipe(response);
  else response.end();
}

async function handle(options: Options, request: IncomingMessage, response: ServerResponse) {
  const origin = options.publicUrl ?? `https://${request.headers.host}`;
  const url = new URL(request.url ?? "/", origin);
  const gitea = new Gitea(options.gitea, authorization(request));
  try {
    if (url.pathname === "/api/graphql" && request.method === "POST") {
      const body = JSON.parse((await read(request)).toString());
      send(response, 200, await answer({ gitea, origin }, body));
    } else if (url.pathname === "/api/v3" || url.pathname.startsWith("/api/v3/")) {
      await rest(options, gitea, origin, request, response, url);
    } else {
      await passThrough(options, request, response, url);
    }
  } catch (error) {
    const status = error instanceof GiteaError || error instanceof RestError ? error.status : 500;
    if (status === 500) options.log?.(`error on ${request.method} ${url.pathname}: ${String(error)}`);
    if (!response.headersSent) send(response, status, { message: (error as Error).message });
    else response.end();
  }
}

export function createServer(options: Options) {
  const listener = (request: IncomingMessage, response: ServerResponse) =>
    void handle(options, request, response);
  return options.tls ? createHttps(options.tls, listener) : createHttp(listener);
}
