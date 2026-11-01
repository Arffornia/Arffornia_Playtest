// `--local`: the environment on this machine, for when the cluster is off (spec 016, D14).
//
// - light: the mod PR alone (NeoForge dev server + a client that joins it), ~4 GB RAM;
// - full: the pack at a Provisioning PR, in the production server image (Docker), ~12 GB;
// - web: the website PR with its docker compose dev stack.
// One local environment at a time (Brian's resource rule): the lock file enforces it.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.ARF_PLAYTEST_HOME || path.join(os.homedir(), '.arffornia-playtest');
const LOCK = path.join(HOME, 'env.lock.json');
// Where the repositories are cloned (one folder per repo) and where PR worktrees go.
const REPOS = process.env.ARF_REPOS || path.join(os.homedir(), 'arffornia');
const WT = process.env.ARF_WORKTREES || path.join(REPOS, 'wt');

export const readLock = () => { try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return null; } };

export function localKind(r, opts) {
  if (opts.full) return 'full';
  if (opts.light) return 'light';
  if (/Arffornia_Mods/i.test(r.repo)) return 'light';
  if (/Provisioning/i.test(r.repo)) return 'full';
  if (/Website/i.test(r.repo)) return 'web';
  return 'none';
}

export function plan(r, kind) {
  const repo = path.join(REPOS, r.repo);
  const wt = path.join(WT, `playtest-${r.repo}-${r.n}`);
  const steps = [];
  if (!fs.existsSync(repo)) steps.push(['gh', ['repo', 'clone', r.slug, repo]]);
  steps.push(['git', ['-C', repo, 'fetch', 'origin', `pull/${r.n}/head:playtest/${r.n}`]]);
  steps.push(['git', ['-C', repo, 'worktree', 'add', wt, `playtest/${r.n}`]]);
  if (kind === 'light') {
    // NeoForge dev run: a dedicated server and a client that joins it (Quick Play, 1.20+).
    steps.push(['sh', ['-c', `cd ${wt} && ./gradlew runServer --args=nogui`], { background: 'server', wait: /Done \(/ }]);
    steps.push(['sh', ['-c', `cd ${wt} && ./gradlew runClient --args="--quickPlayMultiplayer localhost:25565"`], { background: 'client' }]);
  } else if (kind === 'full') {
    // The pack from this Provisioning PR (served from its worktree), in the production server image.
    steps.push(['sh', ['-c', `docker run -d --name arf-playtest -p 25565:25565 -e EULA=TRUE -e TYPE=NEOFORGE -e VERSION=1.21.1 -e NEOFORGE_VERSION=21.1.172 -e MEMORY=12G -e ONLINE_MODE=FALSE -v ${wt}/config/server/storage:/data itzg/minecraft-server:2025.12.1-java21`]]);
    steps.push(['echo', ['Then start the beta launcher on Production and add localhost:25565, or join it from any NeoForge 21.1.172 instance with the pack.']]);
  } else if (kind === 'web') {
    steps.push(['sh', ['-c', `cd ${wt} && docker compose -f docker-compose-dev.yaml up -d`]]);
    steps.push(['echo', ['The website runs on http://localhost (see docker-compose-dev.yaml). Seed it with: docker compose -f docker-compose-dev.yaml exec php php artisan migrate --force && docker compose -f docker-compose-dev.yaml exec php php artisan db:seed --class=E2ESeeder --force']]);
  } else steps.push(['echo', [`No local environment for ${r.slug}; open https://github.com/${r.slug}/pull/${r.n}`]]);
  return { wt, steps };
}

const show = ([cmd, args, o]) => `  $ ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}${o?.background ? '   &' : ''}`;

export async function upLocal(r, opts, log = console.log) {
  const kind = localKind(r, opts);
  const lock = readLock();
  if (lock && !opts['dry-run']) throw new Error(`a local environment is already running (${lock.pr}, ${lock.kind}). Run "playtest down --local" first: one at a time.`);
  const p = plan(r, kind);
  log(`local environment: ${kind}`);
  p.steps.forEach((s) => log(show(s)));
  if (opts['dry-run']) return { kind, steps: p.steps };
  fs.mkdirSync(HOME, { recursive: true });
  const pids = [];
  for (const [cmd, args, o] of p.steps) {
    if (!o?.background) { execFileSync(cmd, args, { stdio: 'inherit' }); continue; }
    const logFile = path.join(HOME, `${o.background}.log`);
    const out = fs.openSync(logFile, 'w');
    const c = spawn(cmd, args, { detached: true, stdio: ['ignore', out, out] });
    c.unref(); pids.push(c.pid);
    if (o.wait) {
      process.stdout.write(`waiting for ${o.background}`);
      while (!o.wait.test(fs.readFileSync(logFile, 'utf8'))) { await new Promise((s) => setTimeout(s, 2000)); process.stdout.write('.'); }
      log(' ready');
    }
  }
  fs.writeFileSync(LOCK, JSON.stringify({ pr: r.ref, kind, wt: p.wt, pids, at: new Date().toISOString() }, null, 1));
  return { kind, steps: p.steps };
}

export function downLocal(log = console.log) {
  const lock = readLock();
  if (!lock) return log('no local environment is running');
  for (const pid of lock.pids || []) { try { process.kill(-pid); } catch { try { process.kill(pid); } catch { /* gone */ } } }
  if (lock.kind === 'full') { try { execFileSync('docker', ['rm', '-f', 'arf-playtest'], { stdio: 'ignore' }); } catch { /* not running */ } }
  if (lock.kind === 'web') { try { execFileSync('sh', ['-c', `cd ${lock.wt} && docker compose -f docker-compose-dev.yaml down`], { stdio: 'ignore' }); } catch { /* not running */ } }
  fs.rmSync(LOCK);
  log(`stopped ${lock.pr}. The worktree stays at ${lock.wt} (git worktree remove it when done).`);
}
