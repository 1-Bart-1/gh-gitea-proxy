import type { GRepo, GUser } from "../types.ts";
import { paged, route } from "./router.ts";
import * as shape from "./shape.ts";

route("GET", "", async () => ({ current_user_url: "user" }));

route("GET", "meta", async () => ({ verifiable_password_authentication: false, installed_version: "3.14.0" }));

route("GET", "user", async ({ gitea }) => shape.user(await gitea.get<GUser>("user")));

route("GET", "users/:login", async ({ gitea, params }) =>
  shape.user(await gitea.get<GUser>(`users/${params.login}`)));

route("GET", "user/repos", async (request) => {
  const repos = await request.gitea.all<GRepo>("user/repos");
  return paged(request, "user/repos", repos.map((repo) => shape.repo(request.origin, repo)));
});
