#!/usr/bin/env node
// The reaper (spec 016, D6): frees slots whose env file expired, whose PRs are closed or merged,
// or whose file is invalid. Run by .github/workflows/reap.yml every 3 hours; `--dry-run` only
// reports. Argo CD then prunes the environment. Nightly sleep (OffhoursSchedule in infra) and
// the homelab being off stop environments without touching the files.
import fs from 'node:fs';
import { parseRef, validateEnv, isExpired } from './lib/slots.mjs';
import { makeGh, makeStore } from './lib/github.mjs';

// What to do with each slot file: { slot, reason } for the ones to free.
export function verdicts(files, gh, now) {
  const out = [];
  for (const [slot, f] of Object.entries(files)) {
    if (!f.env) { out.push({ slot, sha: f.sha, reason: `unreadable (${f.error})` }); continue; }
    const errs = validateEnv(`envs/${slot}.yaml`, f.env, now);
    if (errs.length) { out.push({ slot, sha: f.sha, reason: `invalid: ${errs.join('; ')}` }); continue; }
    if (isExpired(f.env, now)) { out.push({ slot, sha: f.sha, reason: `expired ${f.env.expires}` }); continue; }
    for (const ref of [].concat(f.env.prs)) {
      const r = parseRef(ref);
      let pr = null;
      try { pr = gh.pr(r); } catch (e) { if (e.status !== 404) throw e; }
      if (!pr || pr.state !== 'open') {
        out.push({ slot, sha: f.sha, reason: `${ref} is ${pr ? (pr.merged_at ? 'merged' : 'closed') : 'gone'}` });
        break;
      }
    }
  }
  return out;
}

export function reap({ gh, store, now, dryRun, log = console.log }) {
  const files = store.list();
  const todo = verdicts(files, gh, now);
  for (const v of todo) {
    log(`${dryRun ? 'would free' : 'freeing'} ${v.slot}: ${v.reason}`);
    if (!dryRun) store.remove(v.slot, v.sha, `playtest: reap ${v.slot} (${v.reason.slice(0, 120)})`);
  }
  const kept = Object.keys(files).filter((s) => !todo.some((v) => v.slot === s));
  log(`${todo.length} freed, ${kept.length} kept${kept.length ? ` (${kept.map((s) => `${s} until ${files[s].env.expires}`).join(', ')})` : ''}`);
  return { freed: todo, kept };
}

const self = new URL(import.meta.url).pathname;
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(self)) {
  const gh = makeGh();
  const lines = [];
  const log = (m) => { console.log(m); lines.push(`- ${m}`); };
  try {
    reap({ gh, store: makeStore(gh), now: Date.now(), dryRun: process.argv.includes('--dry-run'), log });
  } catch (e) {
    console.error(`reap: ${e.message}`);
    process.exitCode = 1;
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Playtest reaper\n\n${lines.join('\n')}\n`);
}
