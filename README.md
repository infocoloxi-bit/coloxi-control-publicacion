# Controlled web publication

This public repository contains the publication controller only. Application source,
commercial data and build artifacts remain in the private source repository. Never
attach a private archive, Worker bundle, source map or API response to an issue, log
or artifact in this repository.

## Authorization

`main` must require a current code-owner approval, the four Controller CI checks,
conversation resolution, and enforcement for administrators. Force pushes and branch
deletion are disabled; squash, rebase and auto-merge are disabled. The `web-production`
environment accepts only `main`. Configure secrets only after these rules are verified.
Source repository writers do not thereby obtain access to the controller's credentials.
The source repository's private Free `main` remains unprotected; this controller does
not claim otherwise. It enforces the separate production publication boundary.

Each new release changes `releases/web.json` in a reviewed PR. The manifest pins the
approved source main, application SHA, successful four-job CI, exact producer run,
artifact ID and hashes, expected live deployment, and recovery version. The initial
manifest reuses the previously approved build; its one fixed bootstrap exception
cannot authorize another source. Future manifests require producer/application/main
SHAs to coincide and a manual build. Never reuse expired artifacts or silently change
the approved manifest during a publication.

The approved source main must remain in the current main's ancestry. Later changes
to another component do not require rebuilding this already approved web artifact.
Rewritten/diverged history is rejected; this does not authorize any newer artifact.

## Operators: Codex and Antigravity

Both use their own working branch in the source repository. After review/CI and the
release manifest's protected PR merge, either can independently invoke:

```sh
gh workflow run publicar-web.yml -R infocoloxi-bit/coloxi-control-publicacion --ref main -f operacion=verify -f confirmar=false
gh workflow run publicar-web.yml -R infocoloxi-bit/coloxi-control-publicacion --ref main -f operacion=publish -f confirmar=true
gh run list -R infocoloxi-bit/coloxi-control-publicacion --workflow publicar-web.yml
gh run view RUN_ID -R infocoloxi-bit/coloxi-control-publicacion
```

An already current application returns `ALREADY_CURRENT_NO_WRITE`. No redundant
deployment is made. A different or uncertain live state blocks publication; reconcile
administratively before retrying. A confirmed HTTP regression triggers one rollback.
An explicitly authorized manual rollback uses `operacion=rollback -f confirmar=true`
and only the recovery version in the reviewed manifest.

## Credentials and scope

Environment secrets: `SOURCE_READER_TOKEN` (selected private source repository only:
Actions Read and Contents Read) and `CF_WORKER_PUBLISH_TOKEN` (Individual Workers
Editor, exact existing web Worker only). The source credential cannot publish; the
Worker credential cannot edit this controller or other Cloudflare destinations.
Environment variables: `SOURCE_REPOSITORY`, `CF_ACCOUNT_ID`, `CF_WORKER_NAME`,
`PUBLIC_ORIGINS` (JSON array of public HTTPS origins). No values belong in code/logs.
Rotate the read-only credential on expiry; normal publications require no local token.

The controller never runs downloaded application code, package scripts, configuration,
or workflows with deployment credentials. It generates its own Wrangler configuration,
preserves existing variables/secrets, and does not modify routes, DNS, D1 or other Workers.
Private artifacts are downloaded only to the ephemeral runner, never uploaded here.

Only Web (`publicar-web.yml`, environment `web-production`) and commercial PWA (`publicar-pwa.yml`, environment `pwa-production` with `CF_PAGES_PUBLISH_TOKEN` for Cloudflare Pages project `coloxi-app` / `app.coloxi.net`) are enabled. Telegram, training and Hostinger are not enabled by this controller.
