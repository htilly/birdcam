# Agent instructions

Notes for AI coding agents (and humans) working in this repo.

## Branches and deploy

- Work from `main`. Branch off it for each change and open a PR against `main`.
- Merging to `main` builds the image and deploys it to the production host automatically
  (`.github/workflows/docker-build-push.yml`, then `deploy.yml`). Check that both runs succeed.
- After a deploy, `GET /api/build-info` shows what is running, e.g. `v1.2.0 (#103 · abc1234)`.

## Versioning

The version in `package.json` is shown in the UI and is **only changed by hand**, so every PR
must decide whether to bump it. Bump it in the same PR as the change:

```bash
npm version <patch|minor|major> --no-git-tag-version
```

This updates both `package.json` and `package-lock.json`; commit both.

| Bump | When | Examples |
|------|------|----------|
| `patch` (1.2.0 → 1.2.1) | Bug fixes and changes users don't need to learn about | fix time sync, tune motion detection, extra logging/diagnostics, dependency updates |
| `minor` (1.2.0 → 1.3.0) | New user-visible feature or setting | new admin setting or page, new API endpoint, new notification type |
| `major` (1.2.0 → 2.0.0) | Breaking: an upgrade needs manual steps | new required env var, config/volume layout change, removed feature, DB change that is not migrated automatically |
| none | Nothing in the running app changes | docs only, tests only, CI/workflow-only changes |

- One bump per PR, the highest that applies (a fix plus a new setting is `minor`).
- Bump relative to `main` at merge time. If another PR bumped first, rebase and bump again from
  the new version instead of keeping your old number.
- The CI build number (`#103`) and commit hash are added automatically; never edit those.
- Mention the new version in the PR description.

## Tests

- `npm test` runs the Node test suite. Native modules (`better-sqlite3`) must match the local
  Node version; run `npm ci` if DB tests fail with a module version error.
- `motion/motion.py` (Python, OpenCV) has no unit tests; it runs inside the Docker image.
