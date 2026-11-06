// GitHub access through the `gh` CLI (REST only), and the env-file store on the `envs` branch.
//
// Writes are safe for agents and for two people racing for the same slot:
// - normal commits on `envs` only (never a force-push, never `main`);
// - every write is checked against the blob SHA read before (none for a create), so a slot that
//   someone else changed in between is refused, never overwritten;
// - two writers: the contents API (GitHub refuses a stale SHA with 409/422), or plain git (the
//   commit is rebuilt on the fetched `envs` head after the same SHA check, and a non-fast-forward
//   push is refused by the server). `auto` uses the API and falls back to git where the API
//   refuses writes (some agent sandboxes allow git pushes but not REST writes);
// - `--via-pr` puts the same commit on a new `playtest/<slot>-<time>` branch and opens a PR
//   into `envs` instead, for sessions that may not commit to a shared branch.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// A small clone of the `envs` branch, written with plain git. `url` defaults to GitHub over HTTPS
// (gh's credential helper, or the agent sandbox's git proxy).
export function makeGitWriter({ repo = PLAYTEST_REPO, branch = ENVS_BRANCH, url = process.env.ARF_PLAYTEST_GIT_URL || `https://github.com/${repo}.git`, dir = path.join(process.env.ARF_PLAYTEST_HOME || path.join(os.homedir(), '.arffornia-playtest'), 'envs-git'), login = () => 'playtest' } = {}) {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const ident = () => {
    const who = login();
    return ['-c', `user.name=${who}`, '-c', `user.email=${who}@users.noreply.github.com`];
  };
  function sync() {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['clone', '-q', '--single-branch', '--branch', branch, url, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    git('fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
    git('checkout', '-q', '-B', 'playtest-work', `origin/${branch}`);
  }
  const blobOf = (file) => { try { return git('rev-parse', `HEAD:${file}`); } catch { return null; } };

  // Writes `text` (null deletes) to `file` if its blob is still `expected`; pushes to `target`
  // (the envs branch, or a new branch for --via-pr). Retries when only other files moved.
  function write(file, text, expected, message, target = branch) {
    for (let attempt = 0; attempt < 3; attempt++) {
      sync();
      if ((blobOf(file) || null) !== (expected || null)) throw new GhError(`stale ${file}`, 409);
      const abs = path.join(dir, file);
      if (text === null) git('rm', '-q', file);
      else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); git('add', file); }
      execFileSync('git', ['-C', dir, ...ident(), 'commit', '-q', '-m', message], { stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        git('push', '-q', 'origin', `HEAD:refs/heads/${target}`);
        return { commit: { sha: git('rev-parse', 'HEAD') } };
      } catch (e) {
        if (target !== branch || !/rejected|non-fast-forward|fetch first/i.test(`${e.stderr}`)) throw new GhError(`git push failed: ${String(e.stderr || e.message).trim().split('\n').pop()}`, 0);
      }
    }
    throw new GhError(`${branch} kept moving`, 409);
  }
  return { write };
}

export function makeStore(gh, { repo = PLAYTEST_REPO, branch = ENVS_BRANCH, writer = process.env.ARF_PLAYTEST_WRITE || 'auto', git = null } = {}) {
  const path = (slot) => `envs/${slot}.yaml`;
  let gitWriter = git;
  const viaGit = () => (gitWriter ||= makeGitWriter({ repo, branch, login: () => { try { return gh.login(); } catch { return 'playtest'; } } }));
  const refused = (e) => e.status === 403 && /not permitted|forbidden|Resource not accessible/i.test(e.message);

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
  // One write: `text` null deletes. Tries the writer chosen, falls back from the API to git.
  function write(slot, text, sha, message, viaPr) {
    const file = path(slot);
    const head = viaPr ? `playtest/${slot}-${Date.now().toString(36)}` : null;
    const useApi = () => {
      if (head) {
        const base = gh.get(`repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`).object.sha;
        gh.api('POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${head}`, sha: base });
      }
      const body = { message, branch: head || branch };
      if (text !== null) body.content = b64(text);
      if (sha) body.sha = sha;
      return gh.api(text === null ? 'DELETE' : 'PUT', `repos/${repo}/contents/${file}`, body);
    };
    let res;
    try {
      if (writer === 'git') res = viaGit().write(file, text, sha, message, head || branch);
      else {
        try { res = useApi(); } catch (e) {
          if (writer !== 'auto' || !refused(e)) throw e;
          res = viaGit().write(file, text, sha, message, head || branch);
        }
      }
    } catch (e) { throw conflict(e, slot); }
    if (!head) return { commit: res.commit };
    const pr = gh.api('POST', `repos/${repo}/pulls`, { title: message, head, base: branch, body: 'Opened by `playtest --via-pr`. Merge it with a merge commit to apply; Argo CD follows the `envs` branch.' });
    return { pr: pr.html_url };
  }

  // Creates or replaces a slot file. `sha` is the blob SHA read before (null to create).
  const put = (slot, env, sha, message, { viaPr = false } = {}) => write(slot, serializeEnv(env), sha, message, viaPr);
  const remove = (slot, sha, message, { viaPr = false } = {}) => write(slot, null, sha, message, viaPr);

  return { list, read, put, remove };
}
