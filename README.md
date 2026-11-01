# Arffornia playtest

Everything between "an agent opened a PR" and "Brian says it works":

- `kit/`: **`playtest up <pr>`**. It takes a fixed, capped slot on the homelab cluster for a PR,
  waits until it answers, and prints the URL and a 10-minute checklist. Argo CD builds the
  environment from a small file in this repo (spec 016, phase 3).
- `envfiles/`: **pack-files**, the small nginx that serves a modpack ref to the test server and
  the beta launcher, with the mod tag and the test profile applied (below).
- `checklists/sessions.json`: the checklist rows for the held class-C PRs, grouped into the 4
  playtest sessions of spec 016. `playtest checklist` and `playtest card` read it.
- `agent/`: the autonomous playtester (a dev-only probe mod and its tools). Not wired in yet.

## Install the `playtest` command

`playtest` needs Node 20+ and the GitHub CLI (`gh`, logged in). Pick one:

```sh
# Nix (NixOS, or any machine with flakes)
nix profile install github:Arffornia/Arffornia_Playtest
nix run github:Arffornia/Arffornia_Playtest -- status        # or run it once without installing

# npm (any OS)
npm install -g github:Arffornia/Arffornia_Playtest

# from a clone, no install
node kit/playtest.mjs status
```

On NixOS you can also take `packages.<system>.playtest` from this flake as an input of your
system configuration.

## Use it

```sh
playtest up Arffornia/Arffornia_Website#115        # a website slot: https://pr1.arffornia.com/
playtest up Arffornia/Arffornia_Mods#49 Arffornia/Arffornia_Provisioning#35
                                                   # the pack slot: beta launcher, Test slot
playtest status                                    # slots, who holds them, expiry, health
playtest extend pr1 24h                            # more time (7 days at most)
playtest down pr1                                  # free it now
playtest checklist Arffornia/Arffornia_Website#91  # the checklist rows for a PR
playtest report Arffornia/Arffornia_Website#115 --verdict ok --notes "..." --post
```

A PR URL works too. `playtest help` lists every flag.

### The slots

| Slot | Address | Runs | Cap |
|---|---|---|---|
| `pr1`, `pr2`, `pr3` | `https://pr<k>.arffornia.com/` | one Website PR: its chart and its `pr-<n>-<sha7>` images, its own seeded Postgres | 768 MiB each |
| `slot` | `test.arffornia.com:25566` (whitelisted), files on `https://test.arffornia.com/pack/` | the pack: a Provisioning PR, a Mods PR (`pr-<n>` jar), or both. With no file, it runs `main` with the `edge` mod: that is the staging server | 16 GiB |

Launcher PRs have no slot: `playtest up` prints where to download their beta artifact
(`launcher-pr-<n>`). Fork PRs are never deployed.

### What `up` does

1. Checks every PR: open, from this repository, CI green on the head, and what the slot pulls
   is published (the website `pr-<n>-<sha7>` images, the mod `pr-<n>` pre-release).
   `--force` deploys anyway.
2. Checks that the cluster answers (`staging.arffornia.com`). If it does not, it stops and offers
   `--local`. `--no-wait` skips the wait and prepares the slot for when the cluster is back:
   that is how an agent sets a slot up before Brian opens the card.
3. Takes a slot: the one in `--slot`, the slot that already holds these PRs (it is refreshed to
   the new head), or the first free one. An expired slot counts as free.
4. Writes `envs/<slot>.yaml` on the `envs` branch (below), waits until the URL answers (website
   `/`; pack: pack-files serves the requested ref and the server answers a ping), then prints the
   URL and the checklist, and opens the browser for a website slot.

### Agents and concurrent writes

The slot files live on the **`envs` branch** of this repo, never on `main`. Every write is a
normal commit through the contents API. There is no force-push, and no history rewrite:

- creating a slot file sends no blob SHA, so it fails if someone created it first;
- updating or deleting sends the SHA it read, so it fails if someone changed it in between.

Either way `playtest` says "changed while this command ran" and nothing is overwritten. With
`--via-pr`, the same change goes on a new `playtest/<slot>-<time>` branch with a PR into
`envs` instead; merging it (merge commit) applies it. Use it where committing to a shared branch
is not allowed.

The file format is fixed by `kit/lib/slots.mjs` (`validateEnv`): known slots and kinds, allowed
repositories, full SHAs, a safe character set, and at most 7 days ahead. The CLI refuses to
write anything else, and the reaper removes anything else it finds.

### Expiry, night, cluster off

- **TTL:** 48 h by default (`--ttl`), extendable with `playtest extend`, 7 days at most.
- **Reaper:** `.github/workflows/reap.yml` runs every 3 hours. It deletes the files that
  expired, whose PR is closed or merged, or that are invalid. Argo CD then removes the
  environment.
- **Night:** the slots sleep from 03:00 to 07:00 (Paris) like the prod server, and when the
  homelab is off. The files stay, so the environments come back by themselves.
- **`--local`:** when the cluster is off, `playtest up <pr> --local` runs the light (one mod),
  full (the pack, in Docker) or website (docker compose) environment on this machine. One at a
  time; `playtest down --local` stops it.

## How the cluster side works

All of it is in [TheGostsniperfr/infra](https://github.com/TheGostsniperfr/infra) (`k8s/apps/arffornia/playtest`,
`k8s/config/arffornia/{staging,slot,previews,playtest}`):

- Two Argo CD `ApplicationSet`s read `envs/*.yaml` here (git file generator, public repo, no
  token): `playtest-website` makes one app per `pr<k>.yaml`, `playtest-pack` keeps the `slot`
  app on `main` and `edge` unless `slot.yaml` overrides it.
- Their `AppProject` `playtest` allows only the slot namespaces, no cluster-scoped objects, and
  no `VaultSecret`, `NetworkPolicy`, `ResourceQuota`, RBAC or Argo objects.
- Each slot namespace has a `ResourceQuota` (the hard cap), and Kyverno adds a `LimitRange`
  and a default-deny `NetworkPolicy`. Egress goes to DNS, the internet and, for the test
  server, staging; never to prod namespaces, the LAN or Vault. Kyverno also pins the images
  (`ghcr.io/arffornia/*`, `itzg/*`, `postgres`) and the hostnames each namespace may route.
- The test server and both website kinds use staging data only: seed data
  (`E2ESeeder`), staging secrets from Vault (written by Terraform), the staging API.

## pack-files (`envfiles/`)

The config-updater and the launcher read a Provisioning ref over HTTP (`BASE_URL`). pack-files
answers in its place:

- `config/<kind>/modList.json`: the `Arffornia/Arffornia_Mods` entry gets `MOD_TAG` (`edge`,
  `pr-<n>`) instead of `latest`. Nexus_Mods resolves it with `releases/tags/<tag>`, so pre-releases
  work and nothing changes in Nexus_Mods or the config-updater.
- The files listed in the profile (`/etc/pack-files/profile.json`) get string replacements, for
  example the API URL and the database host, so the test server talks to staging. Their hash in
  `config/<kind>/index.json` is recomputed, so the updater accepts them.
- Everything else is proxied to raw GitHub at `PROVISIONING_REF` (`refs/heads/main` or a commit SHA).
- `/_pack` says what it serves; `/healthz` answers `ok`.

`npm test` covers the rewrites; `envfiles/test/smoke.sh` builds the image and runs it against a
fake raw GitHub (needs Docker). The image is published on every `main` push as
`ghcr.io/arffornia/playtest-envfiles:sha-<7>`.

## Rules

Free tools only (GitHub-hosted runners, the homelab cluster). One full-pack environment at a
time. Staging and slots never get prod data or prod secrets. The probe mod never ships in the
player pack.

Specs: [kit](docs/kit-spec.md), [agent](docs/agent-spec.md), and spec 016 in
[Arffornia/docs](https://github.com/Arffornia/docs/blob/main/docs/specs/016-testable-build/spec.md).
