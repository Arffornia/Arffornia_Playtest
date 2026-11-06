#!/usr/bin/env node
// Arffornia playtest: test a pull request from a link, on fixed and capped cluster slots.
//
//   playtest up <pr...> [--slot pr2] [--ttl 24h] [--via-pr] [--no-wait] [--no-open] [--force] [--dry-run]
//        take a slot for these PRs (website: pr1-pr3.arffornia.com; pack: test.arffornia.com:25566),
//        wait until it answers, print the URL and the 10-minute checklist
//   playtest up main [--ttl 24h] [--no-wait]              start the test server on main + edge (no PR)
//   playtest up <pr> --local [--light|--full] [--dry-run]   the same on this machine (cluster off)
//   playtest status [--json] [--no-probe]                 slots, who holds them, expiry, health
//   playtest extend <slot> [24h]                          push the expiry back (7 days at most)
//   playtest down <slot|pr> [--via-pr] | down --local    free a slot, or stop the local environment
//   playtest checklist <pr...>                            the checklist rows for these PRs
//   playtest card [--session A,B] [--out file] [--offline] the review-stack Playtest card (JSON)
//   playtest guide <pr> [--out file]                     the generated test guide for one PR
//   playtest report <pr> --verdict ok|ko [--notes "..."] [--post]   your verdict, review-stack format
//
// Needs Node 20+ and the GitHub CLI (`gh`, logged in, REST only). `--local` also needs git, Java 21
// or Docker. A PR is <owner>/<repo>#<n> or its URL.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SLOTS, PLAYTEST_REPO, ENVS_BRANCH, kindOf, parseRef, parseDuration, MAIN_REF, buildEnv, validateEnv, pickSlot, extendEnv, serializeEnv, DEFAULT_TTL_MS } from './lib/slots.mjs';
import { makeGh, makeStore } from './lib/github.mjs';
import * as health from './lib/health.mjs';
import { checklistText, buildCard, loadSessions } from './lib/card.mjs';
import { guide, loadPR, MARK_REPORT } from './lib/guide.mjs';
import { HOME, upLocal, downLocal } from './lib/local.mjs';

export class UsageError extends Error {}
const fail = (m) => { throw new UsageError(m); };

const FLAGS = ['local', 'light', 'full', 'dry-run', 'via-pr', 'no-wait', 'no-open', 'force', 'json', 'no-probe', 'post', 'offline'];
export function parseArgs(argv) {
  const pos = []; const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) { pos.push(argv[i]); continue; }
    if (m[2] !== undefined) { opts[m[1]] = m[2]; continue; }
    const nx = argv[i + 1];
    if (!FLAGS.includes(m[1]) && nx !== undefined && !nx.startsWith('--')) { opts[m[1]] = opts[m[1]] ? [].concat(opts[m[1]], nx) : nx; i++; } else opts[m[1]] = true;
  }
  return { pos, opts };
}

const heldEnvs = (files) => Object.fromEntries(Object.entries(files).map(([s, f]) => [s, f.env]));

const span = (ms) => {
  const h = Math.round(Math.abs(ms) / 3600e3);
  return h >= 1 ? `${h} h` : `${Math.max(1, Math.round(Math.abs(ms) / 60e3))} min`;
};

// ------------------------------------------------------------------ up
// `playtest up main`: start the test server on Provisioning main + the `edge` mod, no PR.
async function upMain(opts, ctx) {
  const { store, log } = ctx;
  const files = store.list();
  const slot = pickSlot({ kind: 'pack', asked: 'slot', held: heldEnvs(files), prs: [{ ref: MAIN_REF }], now: ctx.now() });
  const ttlMs = opts.ttl ? parseDuration(opts.ttl) : DEFAULT_TTL_MS;
  const env = buildEnv({ slot, prs: [], requestedBy: ctx.login(), now: ctx.now(), ttlMs });
  const errs = validateEnv(`envs/${slot}.yaml`, env, ctx.now());
  if (errs.length) fail(`refusing to write an invalid env file:\n  - ${errs.join('\n  - ')}`);
  if (opts['dry-run']) {
    log(`would write envs/${slot}.yaml on ${PLAYTEST_REPO}@${ENVS_BRANCH}:`);
    log(serializeEnv(env));
    return { slot, env, dryRun: true };
  }
  const res = store.put(slot, env, files[slot]?.sha || null, `playtest: up ${slot} = main + edge`, { viaPr: !!opts['via-pr'] });
  if (res.pr) {
    log(`opened ${res.pr}: merge it (merge commit) to start ${slot}.`);
    return { slot, env, pr: res.pr };
  }
  log(`${slot} = main + edge, until ${env.expires}. The server boots in about 5 to 15 minutes: ${SLOTS[slot].server}`);
  log(`Stop it when done (frees its memory): playtest down ${slot}`);
  if (!opts['no-wait']) {
    const r = await health.waitFor(() => ctx.health.slotUp(slot, env), { timeoutMs: 25 * 60e3, everyMs: ctx.pollMs ?? 15000 });
    log(r.ok ? `${slot} is up (${r.detail}).` : `${slot} is not answering yet (${r.detail}). Check again with: playtest status`);
  }
  return { slot, env };
}

async function up(refs, opts, ctx) {
  const { gh, store, log } = ctx;
  if (!refs.length) fail('playtest up needs at least one PR (owner/repo#n), or "main" for the test server on main');
  if (refs.length === 1 && refs[0] === MAIN_REF) return upMain(opts, ctx);
  const prs = refs.map(parseRef);
  if (opts.local) {
    if (prs.length > 1) fail('--local takes one PR');
    return upLocal(prs[0], opts, log);
  }
  const kinds = [...new Set(prs.map((p) => kindOf(p.slug)))];
  if (kinds.includes(null)) fail(`no slot serves ${prs.filter((p) => !kindOf(p.slug)).map((p) => p.slug).join(', ')}. Try --local, or "playtest guide".`);
  if (kinds.length > 1) fail('these PRs need different kinds of slot: run playtest up once per kind');
  const kind = kinds[0];

  // Facts about each PR: open, from this repository (never a fork), CI state on the head.
  const problems = [];
  for (const p of prs) {
    const pr = gh.pr(p);
    p.head = pr.head.sha;
    p.title = pr.title;
    if (!pr.head.repo || pr.head.repo.full_name !== pr.base.repo.full_name) fail(`${p.ref} comes from a fork: fork code is never deployed on the cluster. Use --local.`);
    if (pr.state !== 'open') problems.push(`${p.ref} is ${pr.merged_at ? 'merged' : 'closed'}`);
    const checks = gh.checks(p.slug, p.head);
    const bad = checks.filter((c) => c.status === 'completed' && !['success', 'skipped', 'neutral'].includes(c.conclusion));
    const pending = checks.filter((c) => c.status !== 'completed');
    if (bad.length) problems.push(`${p.ref}: CI failed on ${p.head.slice(0, 7)} (${bad.map((c) => c.name).join(', ')})`);
    if (pending.length) problems.push(`${p.ref}: CI still running on ${p.head.slice(0, 7)} (${pending.map((c) => c.name).join(', ')})`);
    if (!checks.length) log(`note: ${p.ref} has no check runs on ${p.head.slice(0, 7)}`);
  }

  if (kind === 'launcher') {
    log('Launcher PRs have no slot: test the beta build of the PR on this machine.');
    for (const p of prs) log(`  gh run download --repo ${p.slug} --name launcher-pr-${p.n} --dir ~/Downloads/launcher-pr-${p.n}`);
    log('Install it next to the normal launcher ("Arffornia Launcher Beta"). Checklist:');
    log(checklistText(prs.map((p) => p.ref)));
    return { kind };
  }
  if (kind === 'website' && prs.length !== 1) fail('a website slot takes one PR: run playtest up once per PR (pr1-pr3)');

  // What the environment pulls must exist: the website images, the mod jar.
  for (const p of prs) {
    if (kind === 'website') {
      const tag = `pr-${p.n}-${p.head.slice(0, 7)}`;
      for (const image of ['arffornia/arffornia_website', 'arffornia/nginx_arffornia_website']) {
        const r = await ctx.health.imageExists(image, tag);
        if (r.ok === false) problems.push(`${r.detail} yet (the "Preview images" workflow builds it on each push)`);
        if (r.ok === null) log(`note: could not check ${image}:${tag}: ${r.detail}`);
      }
    } else if (/arffornia_mods$/i.test(p.slug)) {
      const rel = gh.release(p.slug, `pr-${p.n}`);
      if (!rel || !(rel.assets || []).some((a) => a.name === 'arffornia.jar')) problems.push(`${p.ref}: no pre-release pr-${p.n} with arffornia.jar yet (the "Pre-release jars" workflow publishes it)`);
    }
  }
  if (problems.length && !opts.force) fail(`not deploying:\n  - ${problems.join('\n  - ')}\nFix it or wait, or pass --force.`);
  problems.forEach((m) => log(`warning (--force): ${m}`));

  const wait = !opts['no-wait'] && !opts['dry-run'];
  if (wait) {
    const c = await ctx.health.clusterUp();
    if (!c.ok) {
      fail(`the cluster looks off (${c.detail}). Run it on this machine instead:\n  playtest up ${prs[0].ref} --local\nor prepare the slot for later with --no-wait (Argo CD deploys it when the cluster is back).`);
    }
  }

  const files = store.list();
  const slot = pickSlot({ kind, asked: opts.slot, held: heldEnvs(files), prs, now: ctx.now() });
  const ttlMs = opts.ttl ? parseDuration(opts.ttl) : DEFAULT_TTL_MS;
  const env = buildEnv({ slot, prs, requestedBy: ctx.login(), now: ctx.now(), ttlMs });
  const errs = validateEnv(`envs/${slot}.yaml`, env, ctx.now());
  if (errs.length) fail(`refusing to write an invalid env file:\n  - ${errs.join('\n  - ')}`);

  if (opts['dry-run']) {
    log(`would write envs/${slot}.yaml on ${PLAYTEST_REPO}@${ENVS_BRANCH}${files[slot] ? ` (replacing ${files[slot].env?.prsText || 'an unreadable file'})` : ''}:`);
    log(serializeEnv(env));
    return { slot, env, dryRun: true };
  }
  const short = prs.map((p) => `${p.repo}#${p.n}@${p.head.slice(0, 7)}`).join(' + ');
  const res = store.put(slot, env, files[slot]?.sha || null, `playtest: up ${slot} = ${short}`, { viaPr: !!opts['via-pr'] });
  if (res.pr) {
    log(`opened ${res.pr}: merge it (merge commit) to deploy ${slot}.`);
    return { slot, env, pr: res.pr };
  }
  log(`${slot} = ${env.prsText}, until ${env.expires} (playtest extend ${slot} 24h for more).`);

  const where = SLOTS[slot].kind === 'website' ? SLOTS[slot].url : `Beta launcher, Settings, Environment: Test slot (server ${SLOTS[slot].server})`;
  if (wait) {
    const timeoutMs = opts.timeout ? parseDuration(opts.timeout) : (kind === 'pack' ? 25 : 10) * 60e3;
    log(`waiting for ${slot} (up to ${span(timeoutMs)}; Argo CD polls the envs branch every 3 min)...`);
    let last = '';
    const r = await health.waitFor(() => ctx.health.slotUp(slot, env), {
      timeoutMs,
      everyMs: ctx.pollMs ?? 15000,
      onTick: (t) => { if (t.detail !== last) { log(`  ${t.detail}`); last = t.detail; } },
    });
    if (!r.ok) log(`${slot} is not answering yet (${r.detail}). Check again with: playtest status`);
  }
  log(`\nOpen: ${where}\n\nChecklist (about 10 minutes):\n${checklistText(prs.map((p) => p.ref))}\n`);
  log(`Then answer OK or KO on the Playtest card, or: playtest report ${prs[0].ref} --verdict ok|ko --notes "..." --post`);
  if (wait && !opts['no-open'] && SLOTS[slot].kind === 'website') ctx.open(SLOTS[slot].url);
  return { slot, env };
}

// ------------------------------------------------------------------ status, extend, down
async function status(opts, ctx) {
  const files = ctx.store.list();
  const rows = [];
  for (const slot of Object.keys(SLOTS)) {
    const f = files[slot];
    const env = f?.env;
    const row = { slot, kind: SLOTS[slot].kind, url: SLOTS[slot].kind === 'website' ? SLOTS[slot].url : SLOTS[slot].server };
    if (f && !env) row.error = f.error;
    if (env) {
      const left = Date.parse(env.expires) - ctx.now();
      Object.assign(row, { prs: env.prsText, by: env.requestedBy, expires: env.expires, left: left > 0 ? `${span(left)} left` : `EXPIRED ${span(left)} ago` });
    } else if (slot === 'slot') row.prs = 'off (start it: playtest up main)';
    if (!opts['no-probe'] && env) row.health = (await ctx.health.slotUp(slot, env)).detail;
    rows.push(row);
  }
  if (opts.json) { ctx.log(JSON.stringify(rows, null, 2)); return rows; }
  for (const r of rows) {
    ctx.log(`${r.slot.padEnd(5)} ${(r.prs || 'free').padEnd(44)} ${(r.by || '').padEnd(16)} ${(r.left || '').padEnd(16)} ${r.url}${r.health ? `  [${r.health}]` : ''}${r.error ? `  (unreadable: ${r.error})` : ''}`);
  }
  return rows;
}

function slotOf(arg, files) {
  if (SLOTS[arg]) return arg;
  const r = parseRef(arg);
  const s = Object.keys(files).find((k) => files[k].env && [].concat(files[k].env.prs).includes(r.ref));
  if (!s) fail(`no slot holds ${r.ref}`);
  return s;
}

function extend(pos, opts, ctx) {
  const [arg, dur = '24h'] = pos;
  if (!arg) fail('playtest extend <slot> [24h]');
  const files = ctx.store.list();
  const slot = slotOf(arg, files);
  const f = files[slot];
  if (!f?.env) fail(`${slot} is free`);
  const env = extendEnv(f.env, parseDuration(dur), ctx.now());
  const res = ctx.store.put(slot, env, f.sha, `playtest: extend ${slot} to ${env.expires}`, { viaPr: !!opts['via-pr'] });
  ctx.log(res.pr ? `opened ${res.pr}: merge it to extend ${slot}.` : `${slot} (${env.prsText}) now expires ${env.expires}.`);
  return env;
}

function down(pos, opts, ctx) {
  if (opts.local) return downLocal(ctx.log);
  const [arg] = pos;
  if (!arg) fail('playtest down <slot|pr>, or playtest down --local');
  const files = ctx.store.list();
  const slot = slotOf(arg, files);
  const f = files[slot];
  if (!f) { ctx.log(`${slot} is already free.`); return null; }
  const res = ctx.store.remove(slot, f.sha, `playtest: down ${slot} (${f.env?.prsText || 'unreadable file'})`, { viaPr: !!opts['via-pr'] });
  ctx.log(res.pr ? `opened ${res.pr}: merge it to free ${slot}.` : `${slot} is free. Argo CD removes the environment within a few minutes.`);
  return slot;
}

// ------------------------------------------------------------------ report (review-stack answer)
function report(r, opts, ctx) {
  const verdict = opts.verdict || 'ok';
  if (!['ok', 'ko'].includes(verdict)) fail('--verdict is ok or ko');
  const decisions = Object.fromEntries([].concat(opts.decision || []).map((d) => d.split('=')).map(([k, v]) => [k, { choice: v }]));
  const answer = { at: new Date(ctx.now()).toISOString(), source: 'playtest', pr: r.ref, verdict: verdict === 'ok' ? 'approve' : 'changes', decisions, notes: opts.notes || '' };
  fs.mkdirSync(HOME, { recursive: true });
  const f = path.join(HOME, `answer-${r.repo}-${r.n}.json`);
  fs.writeFileSync(f, JSON.stringify(answer, null, 2));
  const body = [MARK_REPORT, `**Playtest by the maintainer: ${verdict === 'ok' ? 'works' : 'does not work yet'}**`, '', answer.notes || '_no notes_', '',
    Object.keys(decisions).length ? `Decisions: ${Object.entries(decisions).map(([k, v]) => `${k} = ${v.choice}`).join(', ')}` : '', '',
    '<details><summary>review-stack answer</summary>', '', '```json', JSON.stringify(answer, null, 2), '```', '</details>'].join('\n');
  if (opts.post) { ctx.gh.api('POST', `repos/${r.slug}/issues/${r.n}/comments`, { body }); ctx.log(`posted on ${r.ref}`); } else ctx.log(body);
  ctx.log(`answer: ${f}`);
  return answer;
}

// ------------------------------------------------------------------ cli
function openUrl(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* no browser: the URL is printed */ }
}

export function defaultCtx() {
  const gh = makeGh();
  let login;
  return {
    gh,
    store: makeStore(gh),
    health,
    now: () => Date.now(),
    log: (...a) => console.log(...a),
    open: openUrl,
    login: () => (login ||= gh.login()),
  };
}

export async function run(argv, ctx = defaultCtx()) {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest);
  switch (cmd) {
    case 'up': return up(pos, opts, ctx);
    case 'status': return status(opts, ctx);
    case 'extend': return extend(pos, opts, ctx);
    case 'down': return down(pos, opts, ctx);
    case 'checklist': ctx.log(checklistText(pos.map((p) => parseRef(p).ref))); return null;
    case 'card': {
      const only = opts.session ? String(opts.session).split(',') : null;
      let held = {};
      const titles = {};
      if (!opts.offline) {
        held = heldEnvs(ctx.store.list());
        for (const s of loadSessions()) for (const r of s.rows) { try { titles[r.pr] = ctx.gh.pr(parseRef(r.pr)).title; } catch { /* keep the checklist title */ } }
      }
      const card = buildCard({ only, held, titles });
      const out = JSON.stringify(card, null, 2);
      if (opts.out) fs.writeFileSync(opts.out, `${out}\n`); else ctx.log(out);
      return card;
    }
    case 'guide': {
      const r = parseRef(pos[0]);
      const g = guide(r, loadPR(r));
      if (opts.out) fs.writeFileSync(opts.out, g); else ctx.log(g);
      return g;
    }
    case 'report': return report(parseRef(pos[0]), opts, ctx);
    default: {
      const help = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
      ctx.log(help);
      if (cmd && !['help', '--help', '-h'].includes(cmd)) throw new UsageError(`unknown command "${cmd}"`);
      return null;
    }
  }
}

const self = new URL(import.meta.url).pathname;
const isMain = process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(self);
if (isMain) {
  run(process.argv.slice(2)).catch((e) => {
    console.error(`playtest: ${e.message}`);
    process.exit(e instanceof UsageError ? 2 : 1);
  });
}
