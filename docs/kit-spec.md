# Spec: one-command PR playtest kit

Status: **proposed**, needs Brian's decisions K1 to K5. Date: 2026-10-31. Prototype: `kit/playtest.mjs`.

## What Brian asked
In the "awaiting Brian" lane, a button or a command on a PR that starts the server and the game
(launcher or dev client) for that PR, locally or on the one cluster preview slot. Then a guide:
what changed, what to test, what to watch, and the decisions to report back. Resources: one
full-pack environment at a time (~50 GB RAM); light single-mod environments are cheap.

## The flow
1. A PR reaches "awaiting Brian" (review stack). The agent playtest (agent-spec.md) has run.
2. A workflow posts the **playtest guide** as a PR comment (marker `<!-- arffornia-playtest-guide -->`)
   and links it from the review-stack card.
3. Brian runs **one command** (or clicks the card button that copies it):
   `playtest up Arffornia/Arffornia_Mods#52`
   - Light env (mod repos): worktree of the PR head, `runServer` + `runClient` joining it with Quick
     Play (`--quickPlayMultiplayer localhost:25565`). About 4 GB RAM. Several can run in parallel if
     he wants, but the lock keeps one by default.
   - Full env (Provisioning, infra, or label `needs-full-pack`): `--local` runs the production server
     image with the pack at this PR; `--slot` deploys the PR's bundle to the single cluster preview
     slot (a lease; the next PR waits or replaces it).
   - Launcher PRs: build and open the branch. Website PRs: the PR's preview instructions.
4. Brian tests with the guide, then: `playtest report <pr> --verdict ok|ko --notes "..." [--decision D1=a] --post`.
   That posts a comment and writes the answer in the review-stack answer format, which agents read.
5. `playtest down` stops everything and frees the slot.

## The guide (generated, `playtest guide <pr>`)
- Header: PR, commit, environment, risk (high when network, machines or worldgen change).
- Start: the exact command.
- CI state: warns when checks fail or still run ("testing now may waste your time").
- What changed: the PR summary + changed files grouped by area (network, machines, translations,
  recipes, worldgen, screens, config, assets, API, build).
- What the agents already checked: the agent playtest report, if any.
- What to test: the PR's "How to test" section + one checklist line per area.
- What to watch: performance, desync, chunk borders/restarts, unfinished visuals.
- Decisions to report: the PR's decision lines; otherwise a prompt for notes.
- Report back: the command.
The heuristics are the floor. When an agent opens the PR, it writes a "How to test" section from
the spec's acceptance criteria, and the guide picks it up.

## Buttons (later)
- **Review-stack card button**: copies the command (no secrets, works today).
- **Launcher "Preview a PR" tab** (dev mode): lists PRs awaiting Brian, one click runs `playtest up`
  with the launcher's own Java and the pack profile. The nicest path on NixOS and macOS.
- **PR comment `/playtest slot`**: a workflow deploys to the preview slot; needs the homelab up and a
  self-hosted runner or Argo CD pull (ADR-0007 revised to one leased slot).

## Decisions for Brian (defaults in bold)
- **K1 Where the kit lives** (decided 2026-10-31): **`Arffornia/Arffornia_Playtest`**, public, created by Brian (org naming convention `Arffornia/Arffornia_<Name>`), with the agent / agent-kit skill / docs repo.
- **K2 Default target**: **local** (homelab off is fine) / the preview slot.
- **K3 Preview slot policy**: **one slot, leased, last request waits** / last request replaces.
- **K4 Guide posting**: **automatic when the PR enters "awaiting Brian"** / on `/guide` comment only.
- **K5 ADR-0007 change**: **replace "a server per PR" by "one leased full-pack slot + local light envs"**
  (Brian's resource rule) / keep per-PR servers for light envs only.

## Verified
- `playtest guide` on a real PR (Arffornia/Arffornia_Mods#50): correct areas (network, machines,
  translations, screens, recipes), risk high, the PR's summary.
- `playtest up --dry-run` for a mod PR (light) and a Provisioning PR (`--slot`); `playtest report`
  without `--post`.

## Not verified
- `playtest up` for real: no Docker daemon here; the NeoForge dev run was not started in this session.
- The `preview-slot.yml` workflow does not exist yet (infra work, ADR-0007 revision).
