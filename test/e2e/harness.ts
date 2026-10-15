/**
 * The end-to-end setup: a Gitea from `test/e2e/gitea.sh`, the proxy in front of
 * it over TLS with a throwaway certificate, and the real `gh` pointed at the
 * proxy through `GH_HOST`, as a GitHub Enterprise host.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { type AddressInfo, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GITEA_URL = process.env.GITEA_URL ?? "http://localhost:3300";
const ADMIN_TOKEN = process.env.GITEA_TOKEN ?? "";

export interface Result {
  code: number;
  out: string;
  err: string;
}

/** One call to Gitea's own API as the admin, for setting up and checking state. */
export async function admin<T = any>(method: string, path: string, body?: unknown,
  token = ADMIN_TOKEN): Promise<T> {
  const response = await fetch(`${GITEA_URL}/api/v1/${path}`, {
    method,
    headers: { authorization: `token ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A self-signed certificate for localhost, which gh trusts through `SSL_CERT_FILE`. */
function certificate(directory: string) {
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", cert, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  return { key, cert };
}

export interface Harness {
  host: string;
  token: string;
  /** The environment gh runs with, for git commands that call back into it. */
  env: Record<string, string | undefined>;
  login: string;
  /** Run gh as the test user, against the proxy. */
  gh(args: string[], options?: { input?: string; cwd?: string; env?: Record<string, string> }): Result;
  /** Run gh and fail with its stderr unless it exits 0; its stdout. */
  ok(args: string[], options?: { input?: string; cwd?: string; env?: Record<string, string> }): string;
  /** Run gh and parse its stdout as JSON. */
  json<T = any>(args: string[]): T;
  close(): Promise<void>;
}

const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => resolve(port));
  });
});

async function listening(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = createConnection(port, "127.0.0.1", () => {
        socket.end();
        resolve(true);
      }).on("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the proxy never listened on ${port}`);
}

let shared: Promise<Harness> | undefined;

/** The harness, set up once per test process. */
export const harness = (): Promise<Harness> => (shared ??= start());

async function start(): Promise<Harness> {
  if (!ADMIN_TOKEN) throw new Error("GITEA_TOKEN is unset: eval \"$(test/e2e/gitea.sh)\" first");
  const directory = mkdtempSync(join(tmpdir(), "gh-gitea-proxy-"));
  const tls = certificate(directory);
  const port = Number(process.env.PROXY_PORT) || await freePort();
  // A child process, because gh runs synchronously and would block an in-process server.
  const proxy = spawn(process.execPath, [join(import.meta.dirname, "../../src/main.ts")], {
    env: { ...process.env, GITEA_URL, PORT: String(port), TLS_KEY: tls.key, TLS_CERT: tls.cert },
    stdio: ["ignore", "ignore", process.env.PROXY_LOG ? "inherit" : "ignore"],
  });
  await listening(port);
  const host = port === 443 ? "localhost" : `localhost:${port}`;
  const login = (await admin<{ login: string }>("GET", "user")).login;
  const env = {
    ...process.env, GH_HOST: host, GH_ENTERPRISE_TOKEN: ADMIN_TOKEN, SSL_CERT_FILE: tls.cert,
    GH_CONFIG_DIR: join(directory, "gh"), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0", GIT_SSL_CAINFO: tls.cert,
    GIT_CONFIG_GLOBAL: join(directory, "gitconfig"),
  };
  const gh: Harness["gh"] = (args, options = {}) => {
    const result = spawnSync("gh", args, {
      env: { ...env, ...options.env }, input: options.input, cwd: options.cwd ?? directory,
      encoding: "utf8", timeout: 60_000,
    });
    return { code: result.status ?? 1, out: result.stdout, err: result.stderr };
  };
  const ok: Harness["ok"] = (args, options) => {
    const result = gh(args, options);
    if (result.code !== 0) {
      throw new Error(`gh ${args.join(" ")} exited ${result.code}:\n${result.err}${result.out}`);
    }
    return result.out;
  };
  return {
    host, token: ADMIN_TOKEN, env, login, gh, ok,
    json: (args) => JSON.parse(ok(args)),
    close: async () => {
      proxy.kill();
    },
  };
}

/** The trailing number of the URL a `gh ... create` prints, as the Agents box reads it. */
export const numberIn = (printed: string): number => Number(/(\d+)\s*$/.exec(printed.trim())?.[1]);

let counter = 0;

/** A fresh repository with an initial commit on `main`, named after the test that owns it. */
export async function freshRepo(prefix: string): Promise<string> {
  const name = `${prefix}-${process.pid}-${Date.now().toString(36)}-${counter++}`;
  const created = await admin<{ full_name: string }>("POST", "user/repos", {
    name, auto_init: true, default_branch: "main", readme: "Default",
  });
  return created.full_name;
}

/** Commit `content` to `path` on `branch`, creating the branch from `main` when it is new. */
export async function commitFile(repo: string, branch: string, path: string, content: string) {
  const branches = await admin<{ name: string }[]>("GET", `repos/${repo}/branches`);
  const fresh = !branches.some((entry) => entry.name === branch);
  return admin<{ commit: { sha: string } }>("POST", `repos/${repo}/contents/${path}`, {
    content: Buffer.from(content).toString("base64"), message: `add ${path}`,
    ...(fresh ? { branch: "main", new_branch: branch } : { branch }),
  });
}
