#!/usr/bin/env bash
# Start a throwaway Gitea and print the environment the end-to-end tests read.
#
#   eval "$(test/e2e/gitea.sh)"     # docker, or podman when docker is absent
#   GITEA_IMAGE=docker.io/gitea/gitea:1.24 test/e2e/gitea.sh
#   GITEA_RUNNER=1 test/e2e/gitea.sh  # and a host-mode Actions runner, for E2E_RUNNER=1
set -euo pipefail

engine=${CONTAINER_ENGINE:-$(docker info >/dev/null 2>&1 && echo docker || echo podman)}
image=${GITEA_IMAGE:-docker.io/gitea/gitea:latest}
port=${GITEA_PORT:-3300}
name=${GITEA_CONTAINER:-gh-gitea-proxy-test}

"$engine" rm -f "$name" >/dev/null 2>&1 || true
"$engine" run -d --name "$name" -p "$port:3000" \
  -e GITEA__security__INSTALL_LOCK=true \
  -e GITEA__database__DB_TYPE=sqlite3 \
  -e GITEA__server__ROOT_URL="http://localhost:$port/" \
  -e GITEA__actions__ENABLED=true \
  -e GITEA__api__MAX_RESPONSE_ITEMS=50 \
  "$image" >/dev/null

for _ in $(seq 60); do
  curl -sf "http://localhost:$port/api/v1/version" >/dev/null && break
  sleep 1
done

"$engine" exec -u git "$name" gitea admin user create --admin --username owner \
  --password owner-password-1 --email owner@example.com --must-change-password=false >/dev/null
token=$(curl -sf -u owner:owner-password-1 -H 'content-type: application/json' \
  -d '{"name":"e2e","scopes":["all"]}' "http://localhost:$port/api/v1/users/owner/tokens" |
  sed -E 's/.*"sha1":"([^"]+)".*/\1/')

if [[ -n ${GITEA_RUNNER:-} ]]; then
  registration=$(curl -sf -X POST -H "authorization: token $token" \
    "http://localhost:$port/api/v1/admin/actions/runners/registration-token" |
    sed -E 's/.*"token":"([^"]+)".*/\1/')
  "$engine" rm -f "$name-runner" >/dev/null 2>&1 || true
  "$engine" run -d --name "$name-runner" --network host \
    -e GITEA_INSTANCE_URL="http://localhost:$port" -e GITEA_RUNNER_REGISTRATION_TOKEN="$registration" \
    -e GITEA_RUNNER_NAME=e2e -e GITEA_RUNNER_LABELS=self-hosted:host \
    "${RUNNER_IMAGE:-docker.io/gitea/act_runner:latest}" >/dev/null
  echo "export E2E_RUNNER=1"
fi

echo "export GITEA_URL=http://localhost:$port GITEA_TOKEN=$token"
