# Deploying to the VPS

The VPS (`ssh vps`, `/home/deploy/career-ops`) runs the [`web/`](../web) dashboard
as a systemd service (`career-ops-web.service`) and is the primary place career-ops
now runs day to day (web UI + phone, over WireGuard). The Mac is a dev environment
only — code gets edited there and pushed out; no career-ops data is generated
there anymore.

## Why git instead of rsync

Every path in the [Data Contract](../DATA_CONTRACT.md)'s User Layer — `data/`,
`reports/`, `output/`, `jds/`, `interview-prep/`, `documents/`, `config/profile.yml`,
`portals.yml`, `modes/_profile.md`, `modes/_custom.md` — is already in `.gitignore`
and has never been committed. That means `git reset --hard origin/main` on the VPS
can only ever touch tracked (System Layer) files: it is structurally incapable of
overwriting reports, the tracker, or profile data, which a blanket `rsync` is not.

## One-time setup (already done)

The VPS directory was originally populated by `rsync` and had no `.git`. It was
converted in place:

```bash
ssh vps
cd /home/deploy/career-ops
git init
git remote add origin https://github.com/D3stan/career-ops.git
git fetch origin main
git checkout -B main origin/main --force   # overwrites only tracked files
```

`git status` came back clean immediately after — the gitignored data directories
were never touched. If you ever rebuild the VPS from scratch, a plain `git clone`
followed by copying `config/profile.yml`, `portals.yml`, `modes/_profile.md`,
`modes/_custom.md`, and the `data/`/`reports/`/etc. directories back in achieves
the same end state.

A narrow passwordless sudo rule lets the `deploy` user restart the web service
without a password prompt (mirrors the existing rule for the VPS's `films`
service):

```bash
echo 'deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart career-ops-web.service, /usr/bin/systemctl status career-ops-web.service' \
  | sudo tee /etc/sudoers.d/career-ops-web
sudo visudo -cf /etc/sudoers.d/career-ops-web   # validates syntax before it's live
sudo chmod 440 /etc/sudoers.d/career-ops-web
```

## Day-to-day deploy

From the Mac, once your changes are committed on `main`:

```bash
npm run deploy
```

This runs [`scripts/deploy-vps.mjs`](../scripts/deploy-vps.mjs), which:

1. Refuses to run if the local branch isn't `main` or the working tree is dirty.
2. `git push origin main`.
3. Over one SSH connection to the VPS: `git fetch` + `git reset --hard
   origin/main`, then conditionally `npm ci` (only if a `package-lock.json`
   changed) and `npm run build` in `web/` (only if anything under `web/`
   changed), then restarts `career-ops-web.service` and confirms it's active.
4. If nothing changed (the VPS is already at the pushed commit), it exits early
   and never touches the service.

Config is overridable via env vars if the host/path/service ever changes —
see the header of `deploy-vps.mjs`: `DEPLOY_HOST`, `DEPLOY_PATH`,
`DEPLOY_SERVICE`, `DEPLOY_BRANCH`.

## Checking it worked

```bash
ssh vps 'sudo systemctl status career-ops-web.service --no-pager'
ssh vps 'cd /home/deploy/career-ops && git log -1 --oneline'
```

## Troubleshooting

- **`npm run deploy` refuses with "working tree has uncommitted changes"** —
  commit or stash first. This is deliberate: deploy only ever ships committed,
  pushed code.
- **Web UI 502s / doesn't reflect the change after deploy** — check
  `journalctl -u career-ops-web.service -n 50 --no-pager` on the VPS; a `next
  build` failure will stop the restart from happening (the script exits
  non-zero) but leaves the previous build running.
- **Root scripts behave oddly after a deploy that touched `package.json`** —
  the conditional `npm ci` only triggers on a `package-lock.json` diff; if a
  script's *behavior* changed without a dependency change this isn't relevant,
  but if you suspect a stale `node_modules`, `ssh vps 'cd
  /home/deploy/career-ops && npm ci'` manually.
