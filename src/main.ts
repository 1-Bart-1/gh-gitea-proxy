import { readFileSync } from "node:fs";
import { createServer } from "./server.ts";

const env = process.env;
const gitea = env.GITEA_URL?.replace(/\/$/, "");
if (!gitea) {
  console.error("GITEA_URL is required, e.g. GITEA_URL=https://gitea.example.com");
  process.exit(2);
}
const tls = env.TLS_KEY && env.TLS_CERT
  ? { key: readFileSync(env.TLS_KEY, "utf8"), cert: readFileSync(env.TLS_CERT, "utf8") }
  : undefined;
const port = Number(env.PORT ?? (tls ? 8443 : 8080));
const host = env.HOST ?? "127.0.0.1";

createServer({
  gitea, tls, publicUrl: env.PUBLIC_URL?.replace(/\/$/, ""),
  log: (line) => console.error(line),
}).listen(port, host, () =>
  console.error(`gh-gitea-proxy for ${gitea} on ${tls ? "https" : "http"}://${host}:${port}`));
