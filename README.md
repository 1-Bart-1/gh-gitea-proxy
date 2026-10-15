# gh-gitea-proxy

Point the unmodified [`gh`](https://cli.github.com) CLI at a [Gitea](https://about.gitea.com) instance. The proxy serves the slice of GitHub Enterprise's REST (`/api/v3`) and GraphQL (`/api/graphql`) API that `gh` and the tools built on it use, answering each call from Gitea's own API. Everything else, git over HTTP included, passes through to Gitea unchanged.

Work in progress: the support checklist lands with the end-to-end tests.

## License

AGPL-3.0-only.
