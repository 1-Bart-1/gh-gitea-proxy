# gh-gitea-proxy

Point the unmodified [`gh`](https://cli.github.com) CLI at a [Gitea](https://about.gitea.com) instance. The proxy plays a GitHub Enterprise host: it serves GitHub's REST (`/api/v3`) and GraphQL (`/api/graphql`) API to `gh`, answering each call from Gitea's own API with the caller's token, and passes everything else, git over HTTP included, through to Gitea.

It covers what [Agents](https://github.com/1-Bart-1/Agents) uses, both the commands its box runs and the ones its agents are told to run. That slice is listed below; anything outside it is not promised.

## How it works

- **GraphQL** is GitHub's published schema ([`schema/github.graphql`](schema/github.graphql), refreshed by `bin/update-schema`), executed by [graphql-js](https://graphql.org/graphql-js/) against model classes in [`src/graphql/models/`](src/graphql/models) that read Gitea. Any query gh sends parses and validates. A field no model implements answers `null`, or an error naming it where the schema forbids `null`.
- **REST** routes in [`src/rest/`](src/rest) reshape Gitea's objects into GitHub's and emit the `Link` headers `gh --paginate` follows.
- **No state.** The proxy holds no credentials and no database. Node IDs encode the Gitea coordinates of the object they name.

## Running it

Gitea 1.27 or newer is required; CI tests 1.27 and the latest release. Earlier versions lack the API for Actions runs and for resolving review comments.

```sh
npm ci
GITEA_URL=https://gitea.example.com PORT=8080 npm start
```

| Variable | Meaning |
| --- | --- |
| `GITEA_URL` | Gitea's base URL as the proxy reaches it. Required. |
| `PORT`, `HOST` | Where to listen; `8080` (or `8443` with TLS) on `127.0.0.1` by default. |
| `TLS_CERT`, `TLS_KEY` | Serve HTTPS directly, instead of behind a reverse proxy. |
| `PUBLIC_URL` | The origin gh uses, when the `Host` header the proxy sees is not it. |

gh only talks HTTPS to an Enterprise host, on port 443 for clone remotes to match, so put the proxy behind TLS on a hostname of its own:

```caddyfile
gh.gitea.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

Then, with a Gitea access token:

```sh
gh auth login --hostname gh.gitea.example.com --with-token <<< "$GITEA_TOKEN"
gh auth setup-git --hostname gh.gitea.example.com
GH_HOST=gh.gitea.example.com gh issue list --repo owner/repo
```

`--repo` also takes `gh.gitea.example.com/owner/repo`. Clones made with `gh repo clone` push and pull through the proxy, authenticated by gh.

## What is different from GitHub

Where Gitea has no equivalent, the proxy emulates GitHub's behaviour:

- **Drafts** are Gitea's `WIP:` title prefix. A draft's title reads without it, and `gh pr ready` and `--undo` remove and add it.
- **Check runs** are Gitea Actions jobs, with GitHub's `…/actions/runs/<run>/job/<job>` details URL. Commit statuses are only the ones something other than Actions posted.
- **Notification `reason`** is `mention` when the latest comment, or else the body, names the viewer; otherwise `assign`, `author` or `subscribed`. `Last-Modified` and `If-Modified-Since` work, so polling is cheap.
- **Reaction IDs** encode who reacted and with what, since Gitea's reactions have no ID.
- **Review threads** are a pull request's review comments grouped by file and line. A reply is a new review comment on the same line.
- **Closing references** (`closedByPullRequestsReferences`, `closingIssuesReferences`) come from GitHub's closing keywords (`fixes #3`) in pull request bodies, in the same repository.
- **`stateReason`** is `COMPLETED` for every closed issue: Gitea does not record `not planned`.
- **Search** covers one repository, given by a `repo:` qualifier, with `is:`, `state:`, `label:`, `author:`, `assignee:`, `head:`, `base:` and `sort:`.
- **Rate limits** are reported as full, since Gitea meters nothing.

## Support checklist

Each item is a call Agents makes. It is checked once an end-to-end test drives it through gh against a real Gitea and passes. The name in backticks is the test's name, and `test/unit/checklist.test.ts` fails when the list and the tests disagree.

### gh subcommands

- [x] `gh auth status`
- [x] `gh repo view --json nameWithOwner`
- [x] `gh repo view in a clone` (needs the proxy on port 443; run in CI)
- [x] `gh repo clone, then git push through gh auth setup-git`
- [x] `gh label create --force`
- [x] `gh issue create`
- [x] `gh issue edit`
- [x] `gh issue comment`
- [x] `gh issue close --reason --comment`
- [x] `gh issue list`
- [x] `gh issue view`
- [x] `gh pr create --draft --label`
- [x] `gh pr ready`
- [x] `gh pr edit`
- [x] `gh pr view --json`
- [x] `gh pr diff`
- [x] `gh pr list`
- [x] `gh pr list --state all after a merge`
- [x] `gh release view`
- [x] `gh release list`
- [ ] `gh search` across repositories: only searches with a `repo:` qualifier are answered

### gh api REST

- [x] `GET user`
- [x] `gh api -i /user rate limit headers`
- [x] `GET /user/repos`
- [x] `GET repos/R`
- [x] `GET repos/R/issues`
- [x] `GET repos/R/issues/N`
- [x] `GET and DELETE repos/R/issues/N/labels`
- [x] `issue comments: list, edit, delete, react`
- [x] `GET repos/R/issues/N/timeline`
- [x] `POST and DELETE repos/R/issues/N/dependencies/blocked_by`
- [x] `GET /issues`
- [x] `GET /issues filter=mentioned and /notifications`
- [x] `GET repos/R/pulls/N`
- [x] `GET repos/R/pulls/N/commits`
- [x] `pull request reviews and review comments`
- [x] `POST repos/R/pulls/N/requested_reviewers`
- [x] `PUT repos/R/pulls/N/update-branch`
- [x] `GET repos/R/commits/SHA/status`
- [x] `GET repos/R/commits/SHA/check-runs`
- [x] `GET repos/R/commits/SHA/check-runs from Gitea Actions`
- [x] `GET repos/R/actions/jobs/N/logs`
- [x] `POST repos/R/actions/runs/N/rerun-failed-jobs`
- [x] `GET repos/R/contents/PATH raw`
- [x] `GET repos/R/commits/REF`
- [x] `GET repos/R/git/ref and POST repos/R/git/refs`
- [x] `POST repos/R/forks`
- [x] `POST repos/R/actions/runners/registration-token`
- [ ] `PUT repos/R/pulls/N/reviews/ID`: Gitea cannot edit a submitted review, so this answers 422
- [ ] `POST repos/R/commits/SHA/comments`: Gitea has no commit comments, so this answers 422 and reads answer `[]`
- [ ] `POST https://uploads.github.com/user-attachments/assets`: no Gitea equivalent

### gh api graphql

The queries Agents sends, verbatim:

- [x] `openPullsIn`
- [x] `writtenOn`
- [x] `changesAt`
- [x] `threadRead`
- [x] `filesAtHeads`
- [x] `openOnHeads`
- [x] `blockersAt`
- [x] `landedOn`
- [x] `openIssuesIn`
- [x] `REVIEW_THREADS and RESOLVE_THREAD`
- [x] `CLOSED_BY`
- [x] `OPEN_THREADS`
- [x] `rateLimit`
- [x] `statusCheckRollup from Gitea Actions`

## Testing

Unit tests need nothing else:

```sh
npm test
```

The end-to-end tests drive the real gh (tested with 2.102) through the proxy at a throwaway Gitea in a container, started by docker or podman:

```sh
eval "$(GITEA_RUNNER=1 test/e2e/gitea.sh)"   # GITEA_RUNNER adds an Actions runner
npm run test:e2e
```

CI runs both against the Gitea versions in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## License

[AGPL-3.0-only](LICENSE). `schema/github.graphql` is GitHub's published GraphQL schema.
