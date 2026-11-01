// pack-files: serves an Arffornia_Provisioning ref for a test environment, with two rewrites.
//
//  1. `config/<kind>/modList.json`: the `github-releases` entries named in the profile
//     (by default Arffornia/Arffornia_Mods) get the tag in $mod_tag (`edge`, `pr-49`, ...)
//     instead of `latest`. Nexus_Mods resolves any other tag with `releases/tags/<tag>`,
//     so pre-releases work and nothing changes in Nexus_Mods or the config-updater.
//  2. The text files listed in the profile (`files[]`) get string replacements, for example
//     the API URL or the database host, so a test server talks to staging and never to prod.
//     Their `hash` in `config/<kind>/index.json` is recomputed (SHA-1, like the generator),
//     so the updater accepts the rewritten file.
//
// Every other path is proxied unchanged to raw GitHub at $upstream_base (see the template).
// The pure helpers are exported too, so `node --test` can check them without nginx.
import fs from 'fs';
import crypto from 'crypto';

const PROFILE_PATH = '/etc/pack-files/profile.json';
const DEFAULT_MODS = [{ owner: 'Arffornia', repoName: 'Arffornia_Mods' }];

function loadProfile(path) {
    let p = {};
    try { p = JSON.parse(fs.readFileSync(path || PROFILE_PATH, 'utf8')); } catch (e) { p = {}; }
    return { mods: p.mods || DEFAULT_MODS, files: p.files || [] };
}

// The `github-releases` entries matching `mods` get `tag`. Returns how many were changed.
function retagMods(list, mods, tag) {
    if (!tag || !list || !list.mods) return 0;
    const entries = list.mods['github-releases'] || [];
    let n = 0;
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (mods.some((m) => m.owner === e.owner && m.repoName === e.repoName)) {
            e.tag = tag;
            n++;
        }
    }
    return n;
}

// Every replacement applies to every occurrence. Returns the new text and whether it changed.
function rewriteText(text, replace) {
    let out = text;
    for (let i = 0; i < (replace || []).length; i++) {
        const r = replace[i];
        if (r.from) out = out.split(r.from).join(r.to === undefined ? '' : String(r.to));
    }
    return { text: out, changed: out !== text };
}

// The replacements for one file of one kind (server, launcher, proxy), or null.
function rulesFor(profile, kind, path) {
    const rules = [];
    for (let i = 0; i < profile.files.length; i++) {
        const f = profile.files[i];
        if (f.path === path && (!f.kinds || f.kinds.indexOf(kind) !== -1)) rules.push.apply(rules, f.replace || []);
    }
    return rules.length ? rules : null;
}

function sha1(data) {
    return crypto.createHash('sha1').update(data).digest('hex');
}

// Recomputes the hash of every rewritten file listed in an index. `fetchText(path)` returns the
// upstream text of `storage/<path>`, or null. Returns the paths whose hash changed.
async function rehashIndex(index, profile, kind, fetchText) {
    const changed = [];
    const files = (index && index.files) || [];
    for (let i = 0; i < files.length; i++) {
        const rules = rulesFor(profile, kind, files[i].path);
        if (!rules) continue;
        const text = await fetchText(files[i].path);
        if (text === null) continue;
        const out = rewriteText(text, rules);
        if (!out.changed) continue;
        files[i].hash = sha1(out.text);
        changed.push(files[i].path);
    }
    return changed;
}

// ------------------------------------------------------------------ nginx handlers
async function raw(r, path) {
    const reply = await r.subrequest('/_raw' + path, { method: 'GET' });
    const body = reply.responseBuffer ? reply.responseBuffer.toString('utf8') : reply.responseText;
    return { status: reply.status, body: body };
}

function send(r, status, type, body) {
    r.headersOut['Content-Type'] = type;
    r.headersOut['Cache-Control'] = 'no-store';
    r.return(status, body);
}

async function modList(r) {
    const m = /^\/config\/([^/]+)\/modList\.json$/.exec(r.uri);
    const up = await raw(r, r.uri);
    if (up.status !== 200 || !m) return r.return(up.status === 200 ? 404 : up.status, up.body);
    let list;
    try { list = JSON.parse(up.body); } catch (e) { return r.return(502, 'upstream modList.json is not JSON'); }
    const n = retagMods(list, loadProfile().mods, r.variables.mod_tag);
    r.headersOut['X-Pack-Retagged'] = String(n);
    send(r, 200, 'application/json', JSON.stringify(list, null, 4));
}

async function index(r) {
    const m = /^\/config\/([^/]+)\/index\.json$/.exec(r.uri);
    const up = await raw(r, r.uri);
    if (up.status !== 200 || !m) return r.return(up.status === 200 ? 404 : up.status, up.body);
    let idx;
    try { idx = JSON.parse(up.body); } catch (e) { return r.return(502, 'upstream index.json is not JSON'); }
    const kind = m[1];
    const changed = await rehashIndex(idx, loadProfile(), kind, async (p) => {
        const f = await raw(r, `/config/${kind}/storage/${p}`);
        return f.status === 200 ? f.body : null;
    });
    r.headersOut['X-Pack-Rewritten'] = String(changed.length);
    send(r, 200, 'application/json', JSON.stringify(idx, null, 2));
}

async function file(r) {
    const m = /^\/config\/([^/]+)\/storage\/(.+)$/.exec(r.uri);
    const rules = m ? rulesFor(loadProfile(), m[1], m[2]) : null;
    if (!rules) return r.internalRedirect('@raw');
    const up = await raw(r, r.uri);
    if (up.status !== 200) return r.return(up.status, up.body);
    send(r, 200, 'text/plain; charset=utf-8', rewriteText(up.body, rules).text);
}

export default { modList, index, file, loadProfile, retagMods, rewriteText, rulesFor, rehashIndex, sha1 };
