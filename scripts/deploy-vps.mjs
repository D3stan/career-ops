#!/usr/bin/env node
/**
 * deploy-vps.mjs — push local commits to the VPS and restart the web service.
 *
 * Deliberately code-only: the VPS's data/, reports/, output/, config/profile.yml,
 * portals.yml, modes/_profile.md, modes/_custom.md etc. are all gitignored, so
 * `git reset --hard` on the remote only ever touches tracked (System Layer)
 * files -- it can never clobber data generated on the VPS. See DATA_CONTRACT.md
 * and docs/DEPLOY_VPS.md.
 *
 * Config (env, all optional):
 *   DEPLOY_HOST     ssh host/alias          default: vps
 *   DEPLOY_PATH     remote repo path        default: /home/deploy/career-ops
 *   DEPLOY_SERVICE  systemd unit to restart default: career-ops-web.service
 *   DEPLOY_BRANCH   branch to deploy        default: main
 */

import { execFileSync } from 'child_process';

const HOST = process.env.DEPLOY_HOST || 'vps';
const REMOTE_PATH = process.env.DEPLOY_PATH || '/home/deploy/career-ops';
const SERVICE = process.env.DEPLOY_SERVICE || 'career-ops-web.service';
const BRANCH = process.env.DEPLOY_BRANCH || 'main';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function runCapture(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
}

function fail(message) {
  console.error(`\ndeploy-vps: ${message}`);
  process.exit(1);
}

console.log(`== 1/3: checking local state (branch ${BRANCH}) ==`);

const currentBranch = runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (currentBranch !== BRANCH) {
  fail(`on branch '${currentBranch}', expected '${BRANCH}'. Switch branches or set DEPLOY_BRANCH.`);
}

const dirty = runCapture('git', ['status', '--porcelain']);
if (dirty) {
  fail('working tree has uncommitted changes. Commit or stash before deploying:\n' + dirty);
}

console.log(`== 2/3: pushing ${BRANCH} to origin ==`);
run('git', ['push', 'origin', BRANCH]);

console.log(`== 3/3: deploying on ${HOST}:${REMOTE_PATH} ==`);

// Single remote script over one SSH connection: pull, conditionally reinstall
// deps / rebuild the web app only for paths that actually changed, restart
// the service only if HEAD actually moved.
const remoteScript = `
set -euo pipefail
cd '${REMOTE_PATH}'

BEFORE="$(git rev-parse HEAD)"
git fetch origin '${BRANCH}' --quiet
git reset --hard 'origin/${BRANCH}'
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "Already up to date ($AFTER) -- nothing to deploy."
  exit 0
fi

CHANGED="$(git diff --name-only "$BEFORE" "$AFTER")"

if echo "$CHANGED" | grep -qx 'package-lock.json'; then
  echo "-- root package-lock.json changed, running npm ci --"
  npm ci --no-audit --no-fund
fi

if echo "$CHANGED" | grep -q '^web/'; then
  echo "-- web/ changed, rebuilding --"
  cd web
  if echo "$CHANGED" | grep -qx 'web/package-lock.json'; then
    npm ci --no-audit --no-fund
  fi
  npm run build
  cd ..
fi

echo "-- restarting ${SERVICE} --"
sudo systemctl restart '${SERVICE}'
sudo systemctl is-active '${SERVICE}'
echo "Deployed $BEFORE -> $AFTER"
`;

run('ssh', [HOST, 'bash', '-se'], { input: remoteScript });

console.log('\ndeploy-vps: done.');
