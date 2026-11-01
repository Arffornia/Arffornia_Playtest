// GitHub access through the `gh` CLI (REST only), and the env-file store on the `envs` branch.
//
// Writes are safe for agents and for two people racing for the same slot:
// - only the contents API, as normal commits on `envs` (never a force-push, never `main`);
// - every update and delete carries the blob SHA it read, and a create carries none, so GitHub
//   refuses the write (409/422) when someone else changed the slot in between;
// - `--via-pr` writes the same commit on a new `playtest/<slot>-<time>` branch and opens a PR
//   into `envs` instead, for sessions that may not commit to a shared branch.
import { execFileSync } from 'node:child_process';
import { PLAYTEST_REPO, ENVS_BRANCH, parseEnv, serializeEnv } from './slots.mjs';

export class GhError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

// The real transport: `gh api`. Returns parsed JSON (or null on an empty body).
export function ghTransport(method, path, body) {
  const args = ['api', '-X', method, path, '-H', 'Accept: application/vnd.github+json'];
  if (body !== undefined) args.push('--input', '-');
  try {
    const out = execFileSync('gh', args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
    return out.trim() ? JSON.parse(out) : null;
  } catch (e) {
    const text = `${e.stderr || ''}${e.stdout || ''}`;
    const m = /HTTP (\d{3})/.exec(text);
    throw new GhError(text.trim().split('\n').pop() || e.message, m ? Number(m[1]) : 0);
  }
}

export function makeGh(transport = ghTransport) {
  const api = (method, path, body) => transport(method, path, body);
  return {
    api,
    get: (path) => api('GET', path),
    pr: (r) => api('GET', `repos/${r.slug}/pulls/${r.n}`),
    checks: (slug, sha) => api('GET', `repos/${slug}/commits/${sha}/check-runs?per_page=100`).check_runs || [],
    release: (slug, tag) => {
      try { return api('GET', `repos/${slug}/releases/tags/${encodeURIComponent(tag)}`); } catch (e) { if (e.status === 404) return null; throw e; }
    },
    login: () => api('GET', 'user').login,
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(String(s).replace(/\n/g, ''), 'base64').toString('utf8');

export function makeStore(gh, { repo = PLAYTEST_REPO, branch = ENVS_BRANCH } = {}) {
  const path = (slot) => `envs/${slot}.yaml`;

  function list() {
    let items;
    try { items = gh.get(`repos/${repo}/contents/envs?ref=${encodeURIComponent(branch)}`); } catch (e) {
      if (e.status === 404) return {};
      throw e;
    }
    const out = {};
    for (const it of items || []) {
      if (it.type !== 'file' || !/^[\w-]+\.yaml$/.test(it.name)) continue;
      const got = read(it.name.replace(/\.yaml$/, ''));
      if (got) out[got.slot] = got;
    }
    return out;
  }

  function read(slot) {
    let f;
    try { f = gh.get(`repos/${repo}/contents/${path(slot)}?ref=${encodeURIComponent(branch)}`); } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    const text = unb64(f.content);
    let env = null, error = null;
    try { env = parseEnv(text); } catch (err) { error = err.message; }
    return { slot, sha: f.sha, env, error, text };
  }

  function conflict(e, slot) {
    if (e.status === 409 || e.status === 422) {
      return new GhError(`${slot} changed while this command ran (someone else took or freed it). Run "playtest status" and try again.`, e.status);
    }
    return e;
  }

  // Creates or replaces a slot file. `sha` is the blob SHA read before (null to create).
  function put(slot, env, sha, message, { viaPr = false } = {}) {
    const body = { message, content: b64(serializeEnv(env)), branch };
    if (sha) body.sha = sha;
    if (viaPr) return viaPullRequest(slot, body);
    try { return { commit: gh.api('PUT', `repos/${repo}/contents/${path(slot)}`, body).commit }; } catch (e) { throw conflict(e, slot); }
  }

  function remove(slot, sha, message, { viaPr = false } = {}) {
    const body = { message, sha, branch };
    if (viaPr) return viaPullRequest(slot, body, true);
    try { return { commit: gh.api('DELETE', `repos/${repo}/contents/${path(slot)}`, body).commit }; } catch (e) { throw conflict(e, slot); }
  }

  function viaPullRequest(slot, body, del = false) {
    const base = gh.get(`repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`).object.sha;
    const head = `playtest/${slot}-${Date.now().toString(36)}`;
    gh.api('POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${head}`, sha: base });
    const onBranch = { ...body, branch: head };
    gh.api(del ? 'DELETE' : 'PUT', `repos/${repo}/contents/${path(slot)}`, onBranch);
    const pr = gh.api('POST', `repos/${repo}/pulls`, { title: body.message, head, base: branch, body: 'Opened by `playtest --via-pr`. Merge it with a merge commit to apply; Argo CD follows the `envs` branch.' });
    return { pr: pr.html_url };
  }

  return { list, read, put, remove };
}
