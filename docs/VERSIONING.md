# Versions and branches

One repository, one codebase. Each version is developed on its own branch, merged into `main` when it is ready, and tagged so it can always be found again.

```
main          what the live server runs; only finished, tested versions are merged here
v6-dev        V6: onboarding + viewership engine (done, not yet merged to main)
v7-dev        work on the next version (V7), branched from v6-dev so it carries all of V6
v5.0, v6.0…   tags: frozen snapshots of each released version
```

| Version | Tag | Contents |
| --- | --- | --- |
| V1 to V4 | (before this repo) | Multi-camera director, cloud OBS, multistreaming, billing |
| V5 | `v5.0` | Viewer comments, admin panel, Cashfree, public website and legal pages, Go Live rename |
| V6 | `v6.0` when released | On `v6-dev`: 5-minute onboarding and the viewership engine (influencers, games, prizes, reports) |
| V7 | `v7.0` when released | On `v7-dev`: the web app — super admin (clubs, users, events, money, SMS, safety, system, reports, audit log, log in as) and the owner/director web with the control room |

## Working on the next version

```bash
git fetch origin
git checkout v6-dev            # first time: git checkout -b v6-dev origin/v6-dev
# ...make changes...
git add -A && git commit -m "V6: what changed"
git push origin v6-dev
```

Small changes can go on their own branch from `v6-dev` (for example `v6-onboarding-wizard`) and be merged back with a pull request.

## Releasing a version

1. All tests pass on `v6-dev` (`cd server && npm test`; `cd mobile && flutter test`).
2. Open a pull request `v6-dev` → `main` on GitHub and merge it.
3. Tag the merge and push the tag:
   ```bash
   git checkout main && git pull
   git tag -a v6.0 -m "Go Live V6"
   git push origin v6.0
   ```
4. Deploy on the server: `cd ~/golive && git fetch --tags && git checkout v6.0`, then `cd infra && docker compose build && docker compose up -d`.
5. Create the next branch: `git checkout -b v7-dev main && git push -u origin v7-dev`.

## Urgent fix to the live version

Fix it on a branch from `main` (`hotfix-<name>`), merge into `main`, tag it `v5.1` (then `v5.2`…), deploy, and merge `main` into the current dev branch so the fix is not lost.

## Going back to an older version

```bash
git checkout v5.0              # look at or run V5 exactly as released
git checkout v6-dev            # back to current work
```

On the server, `git checkout v5.0` and rebuild to roll back. Database changes are additive (new tables and columns), so an older version runs on a newer database; check `server/migrations` before rolling back across a version that removed anything.
