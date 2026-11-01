#!/usr/bin/env bash
# Builds the pack-files image and runs it against a local fake of raw GitHub (an nginx serving
# test/fixture under /Arffornia/Arffornia_Provisioning/refs/heads/main/). Needs Docker.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
img="${IMAGE:-playtest-envfiles:test}"
net="pack-smoke-$$"
cleanup() { docker rm -f "pack-up-$$" "pack-$$" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap cleanup EXIT

[ -n "${SKIP_BUILD:-}" ] || docker build -q -t "$img" "$here/.." >/dev/null
docker network create "$net" >/dev/null
# A plain static nginx (same base image) plays raw GitHub.
docker run -d --name "pack-up-$$" --network "$net" --network-alias upstream \
  -v "$here/fixture:/usr/share/nginx/html/Arffornia/Arffornia_Provisioning/refs/heads/main:ro" \
  nginx:1.27.4-alpine3.21 >/dev/null
docker run -d --name "pack-$$" --network "$net" -p 127.0.0.1::8080 \
  -e PACK_UPSTREAM=http://upstream/Arffornia/Arffornia_Provisioning -e MOD_TAG=pr-49 \
  -v "$here/profile.test.json:/etc/pack-files/profile.json:ro" "$img" >/dev/null
port="$(docker port "pack-$$" 8080 | head -1 | sed 's/.*://')"
base="http://127.0.0.1:$port"
for _ in $(seq 1 30); do curl -fsS "$base/healthz" >/dev/null 2>&1 && break; sleep 0.5; done

fail() { echo "FAIL: $*"; docker logs "pack-$$" 2>&1 | tail -20; exit 1; }
list="$(curl -fsS "$base/config/server/modList.json")" || fail "modList.json"
echo "$list" | grep -q '"tag": "pr-49"' || fail "Arffornia_Mods not retagged"
echo "$list" | grep -q '"tag": "latest"' || fail "other mod should keep latest"
toml="$(curl -fsS "$base/config/server/storage/config/arffornia-common.toml")" || fail "toml"
echo "$toml" | grep -q 'http://staging.test/api' || fail "API URL not rewritten"
echo "$toml" | grep -q 'postgres-cluster' && fail "DB host not rewritten"
want="$(printf '%s\n' "$toml" | sha1sum | cut -d' ' -f1)"
got="$(curl -fsS "$base/config/server/index.json" | tr -d ' \n' | grep -o '"path":"config/arffornia-common.toml","hash":"[0-9a-f]*"' | sed 's/.*"hash":"//; s/"//')"
[ "$want" = "$got" ] || fail "index hash $got != sha1 of served file $want"
other="$(curl -fsS "$base/config/server/storage/config/other.toml")" || fail "proxied file"
[ "$other" = "unchanged" ] || fail "plain file changed"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/config/server/storage/config/other.toml")"
[ "$code" = 405 ] || fail "POST should be refused, got $code"
curl -fsS "$base/_pack" | grep -q '"modTag":"pr-49"' || fail "/_pack"
echo "pack-files smoke: OK"
