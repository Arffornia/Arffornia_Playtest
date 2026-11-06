// Slots, env files and their rules (spec 016, phase 3). Pure: no network, no clock of its own.
//
// One file per slot, `envs/<slot>.yaml` on the `envs` branch of Arffornia_Playtest. Argo CD
// (TheGostsniperfr/infra, ApplicationSets `playtest-website` and `playtest-pack`) turns each
// file into an environment. The file format is a flat YAML subset that this module writes and
// reads; `validateEnv` is the contract both sides rely on.

export const PLAYTEST_REPO = process.env.ARF_PLAYTEST_REPO || 'Arffornia/Arffornia_Playtest';
export const ENVS_BRANCH = process.env.ARF_PLAYTEST_BRANCH || 'envs';

export const SLOTS = {
  pr1: { kind: 'website', url: 'https://pr1.arffornia.com/' },
  pr2: { kind: 'website', url: 'https://pr2.arffornia.com/' },
  pr3: { kind: 'website', url: 'https://pr3.arffornia.com/' },
  slot: { kind: 'pack', url: 'https://test.arffornia.com/pack/_pack', server: 'test.arffornia.com:25566' },
};
export const STAGING_URL = 'https://staging.arffornia.com/';

export const DEFAULT_TTL_MS = 48 * 3600e3;
export const MAX_TTL_MS = 7 * 24 * 3600e3;

// Which slot kind a repository's PRs use. Launcher PRs have no slot: they are beta artifacts.
const KINDS = {
  'arffornia/arffornia_website': 'website',
  'arffornia/arffornia_mods': 'pack',
  'arffornia/arffornia_provisioning': 'pack',
  'arffornia/arffornia_launcher_v.5.2': 'launcher',
};
export const kindOf = (slug) => KINDS[slug.toLowerCase()] || null;

// `playtest up main`: the test server on Provisioning main with the `edge` mod, no PR. The
// server only runs while a slot file exists, so this is how to start it for a plain check.
export const MAIN_REF = 'main';

export function parseRef(ref) {
  const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(ref || '') || /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(ref || '');
  if (!m) throw new Error(`expected owner/repo#number or a PR URL, got "${ref}"`);
  return { owner: m[1], repo: m[2], n: Number(m[3]), slug: `${m[1]}/${m[2]}`, ref: `${m[1]}/${m[2]}#${m[3]}` };
}

export function parseDuration(s) {
  const m = /^(\d+)\s*(m|h|d)$/.exec(String(s || '').trim());
  if (!m) throw new Error(`expected a duration like 24h, 90m or 2d, got "${s}"`);
  return Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ------------------------------------------------------------------ env file (de)serialisation
const ORDER = ['slot', 'kind', 'prs', 'prsText', 'head', 'pr', 'imageTag', 'provisioningRef', 'modTag', 'requestedBy', 'requested', 'expires'];
const HEADER = [
  '# Written by `playtest up` (https://github.com/Arffornia/Arffornia_Playtest). One file per slot.',
  '# Argo CD deploys it (TheGostsniperfr/infra, ApplicationSets playtest-*); the reaper removes it',
  '# when it expires or its PR closes. Change it with `playtest extend|down`, not by hand.',
];

export function serializeEnv(env) {
  const keys = [...ORDER.filter((k) => k in env), ...Object.keys(env).filter((k) => !ORDER.includes(k)).sort()];
  return `${[...HEADER, ...keys.map((k) => `${k}: ${JSON.stringify(env[k])}`)].join('\n')}\n`;
}

export function parseEnv(text) {
  const env = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z][\w]*):\s*(.*)$/.exec(line);
    if (!m) throw new Error(`unreadable line: ${line}`);
    const v = m[2].trim();
    if (v.startsWith('"') || v.startsWith('[')) env[m[1]] = JSON.parse(v);
    else env[m[1]] = v.replace(/\s+#.*$/, '');
  }
  return env;
}

// ------------------------------------------------------------------ building and checking
const SAFE = /^[\w.\-#/:+ ]*$/;
const SHA = /^[0-9a-f]{40}$/;
const ALLOWED = {
  website: ['arffornia/arffornia_website'],
  pack: ['arffornia/arffornia_mods', 'arffornia/arffornia_provisioning'],
};

// The env file for `prs` (parsed refs with `head` SHAs) in `slot`.
export function buildEnv({ slot, prs, requestedBy, now, ttlMs = DEFAULT_TTL_MS }) {
  const def = SLOTS[slot];
  if (!def) throw new Error(`unknown slot "${slot}" (slots: ${Object.keys(SLOTS).join(', ')})`);
  const env = {
    slot,
    kind: def.kind,
    prs: prs.length ? prs.map((p) => p.ref) : [MAIN_REF],
    prsText: prs.length ? prs.map((p) => `${p.repo}#${p.n}`).join(' + ') : 'main + edge',
  };
  if (!prs.length && def.kind !== 'pack') throw new Error(`${slot} needs a PR; only the pack slot runs main`);
  if (def.kind === 'website') {
    const [p] = prs;
    Object.assign(env, { head: p.head, pr: String(p.n), imageTag: `pr-${p.n}-${p.head.slice(0, 7)}` });
  } else {
    const mods = prs.find((p) => /arffornia_mods$/i.test(p.slug));
    const prov = prs.find((p) => /arffornia_provisioning$/i.test(p.slug));
    Object.assign(env, { provisioningRef: prov ? prov.head : 'refs/heads/main', modTag: mods ? `pr-${mods.n}` : 'edge' });
  }
  Object.assign(env, { requestedBy, requested: iso(now), expires: iso(now + Math.min(ttlMs, MAX_TTL_MS)) });
  return env;
}

// Errors (strings) for an env file named `envs/<file>.yaml`. Empty means valid.
export function validateEnv(file, env, now = Date.now()) {
  const errs = [];
  const slot = file.replace(/^envs\//, '').replace(/\.yaml$/, '');
  const def = SLOTS[slot];
  if (!def) return [`${file}: not a slot file (slots: ${Object.keys(SLOTS).join(', ')})`];
  for (const [k, v] of Object.entries(env)) {
    for (const s of [].concat(v)) if (typeof s !== 'string' || !SAFE.test(s)) errs.push(`${k}: unsafe or non-string value`);
  }
  if (env.slot !== slot) errs.push(`slot is "${env.slot}" but the file is ${file}`);
  if (env.kind !== def.kind) errs.push(`kind must be "${def.kind}" for ${slot}`);
  const prs = [].concat(env.prs || []);
  if (!prs.length) errs.push('prs is empty');
  const repos = [];
  const isMain = def.kind === 'pack' && prs.length === 1 && prs[0] === MAIN_REF;
  for (const p of isMain ? [] : prs) {
    let r;
    try { r = parseRef(p); } catch { errs.push(`bad PR "${p}"`); continue; }
    if (!(ALLOWED[def.kind] || []).includes(r.slug.toLowerCase())) errs.push(`${p}: this repo has no ${def.kind} slot`);
    if (repos.includes(r.slug.toLowerCase())) errs.push(`${p}: one PR per repository`);
    repos.push(r.slug.toLowerCase());
  }
  if (def.kind === 'website') {
    if (prs.length !== 1) errs.push('a website slot holds exactly one PR');
    if (!SHA.test(env.head || '')) errs.push('head must be a full commit SHA');
    const r = prs[0] && /#(\d+)$/.exec(prs[0]);
    if (!r || env.pr !== r[1]) errs.push('pr must be the PR number');
    if (env.imageTag !== `pr-${env.pr}-${String(env.head || '').slice(0, 7)}`) errs.push('imageTag must be pr-<n>-<sha7>');
  } else {
    if (!(env.provisioningRef === 'refs/heads/main' || SHA.test(env.provisioningRef || ''))) errs.push('provisioningRef must be refs/heads/main or a commit SHA');
    if (!/^(edge|pr-\d+)$/.test(env.modTag || '')) errs.push('modTag must be edge or pr-<n>');
  }
  if (!/^[\w-]+$/.test(env.requestedBy || '')) errs.push('requestedBy must be a GitHub login');
  const req = Date.parse(env.requested), exp = Date.parse(env.expires);
  if (Number.isNaN(req) || Number.isNaN(exp)) errs.push('requested and expires must be ISO dates');
  else if (exp - now > MAX_TTL_MS + 60e3) errs.push('expires is more than 7 days away');
  return errs;
}

export const isExpired = (env, now) => Date.parse(env.expires) <= now;

// The slot to take: the asked one, else the first free website slot, else the pack slot.
// `held` maps slot -> env for the files that exist. A slot is free when it has no file, its
// file has expired, or it already holds exactly these PRs (then `up` refreshes it).
export function pickSlot({ kind, asked, held, prs, now }) {
  const samePrs = (env) => env && [...env.prs].sort().join() === prs.map((p) => p.ref).sort().join();
  const free = (s) => !held[s] || isExpired(held[s], now) || samePrs(held[s]);
  if (asked) {
    if (!SLOTS[asked]) throw new Error(`unknown slot "${asked}"`);
    if (SLOTS[asked].kind !== kind) throw new Error(`${asked} is a ${SLOTS[asked].kind} slot, these PRs need a ${kind} slot`);
    if (!free(asked)) throw new Error(`${asked} is held by ${held[asked].prsText} (${held[asked].requestedBy}) until ${held[asked].expires}. Free it with: playtest down ${asked}`);
    return asked;
  }
  const candidates = Object.keys(SLOTS).filter((s) => SLOTS[s].kind === kind);
  const mine = candidates.find((s) => samePrs(held[s]));
  if (mine) return mine;
  const slot = candidates.find(free);
  if (!slot) {
    const list = candidates.map((s) => `${s}: ${held[s].prsText} until ${held[s].expires}`).join('; ');
    throw new Error(`every ${kind} slot is taken (${list}). Free one with: playtest down <slot>`);
  }
  return slot;
}

export function extendEnv(env, ms, now) {
  const from = Math.max(now, Date.parse(env.expires));
  const cap = now + MAX_TTL_MS;
  return { ...env, expires: iso(Math.min(from + ms, cap)) };
}
