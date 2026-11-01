# Spec: autonomous in-game playtest agent

Status: **proposed**, needs Brian's decisions A1 to A6. Date: 2026-10-31.
Tech-watch card with sources: `agent-playtesting.html` (review page).

## What Brian asked
An agent that takes control of the game, like Claude in Chrome takes control of a browser, and tests
a feature on its own. It is the last check before a human is asked to review or test. Benchmark what
exists, take what works, and do it properly.

## What the research says (short; sources in the card)
- **Pixels-only agents are not ready for this job.** SIMA 2 (DeepMind, Nov 2025) plays from screen and
  keyboard/mouse but is a research preview, and still struggles with precise low-level actions.
  BugCraft (2025) drove Minecraft from screenshots with GPT-4o: 30% of known crash bugs reproduced
  end to end; most failures were agent-side (bad decisions, menu loops). Their own conclusion:
  combine vision with symbolic game state.
- **State abstraction + ranked actions + memory + an LLM oracle** is what made TITAN (2025) work on
  two commercial MMORPGs: 95% task completion, four new bugs, deployed in eight QA pipelines.
- **Aim at the code that changed.** CA2 (2026) feeds the live call stack to the agent and targets
  functions: +8 points success, better function coverage. For a PR, the target is the diff.
- **Bots that join as a network client** (Mineflayer, Mindcraft, the Minecraft MCP servers built on
  them) are good on vanilla servers, but cannot join a NeoForge 1.21.1 server with required mods (no
  modern NeoForge handshake), and cannot see our GUIs or rendering. Useful only for vanilla-level
  smoke checks.
- **In-client MCP mods exist** (MCPFabric, Mine MCP: screenshots, input, inventory, commands, MIT).
  They prove the design and give us a tool list to copy; they target Fabric (MCPFabric lists NeoForge
  too, not verified on 1.21.1).
- **Research agents** (Voyager, JARVIS-1, STEVE-1, GROOT, MineDojo, MineStudio) run on old vanilla
  simulators (MineRL 1.16); they bring ideas (skill library, self-verification, goal-conditioned
  policies) but nothing we can run on a modded 1.21.1 client.
- **Engine-level tests are the backbone.** NeoForge GameTest (server) already runs in our CI; Fabric
  added client game tests (open a world, wait for chunks, take screenshots), NeoForge's own test
  framework covers server-side. The agent sits on top of these, it does not replace them.

## Architecture

```
PR labelled `playtest`
  -> env up (light: mod + deps, headless client under Xvfb; full: the preview slot)
  -> 1. GameTests (server, existing)                         deterministic, minutes
  -> 2. scripted scenarios (agent/scenarios/*.json)          deterministic, replayable
  -> 3. agent session (Claude via Agent SDK + probe MCP)     exploratory, budgeted
  -> report on the PR (marker comment) -> playtest guide for Brian -> review stack
```

- **Probe mod** (dev/test-only, client + server halves, NeoForge 1.21.1): embeds an MCP server on
  `127.0.0.1` with a bearer token. Tools (`agent/tools.json`): `observe` (screenshot + structured
  state + the screen's widget tree, our accessibility tree), `block` (incl. Arffornia machine state),
  `click_widget`, `slot`, `input`, `look`, `goto` (Baritone when present), `use`, `command` (test
  worlds only, for setup), `time` (vanilla `/tick freeze|step` for determinism, `until` predicates),
  `scenario` (reset to a GameTest structure template, log marks, recording), `assert`, `coverage`
  (JaCoCo on both JVMs filtered to the diff).
- **Runner**: Claude through the Agent SDK with `PLAYTESTER.md` as instructions; budget 60 steps /
  20 min; loop detection; every action logged and exported as a scenario file (a passing run becomes
  a regression test, as BugCraft recommends).
- **Oracles**: assertions on structured state first, then log scan (no ERROR from our mods), crash
  detection, screenshot baselines (`shotdiff.py` from spec 007), and an LLM judgement on screenshots
  that is advisory only (never a merge gate).
- **Fallback without the probe**: computer use on the game window (works on any build, slow and
  coarse in 3D; fine for menus and the launcher, which already has Playwright).

## Where it runs (free only)
- Light env: GitHub-hosted runner, Xvfb + Mesa llvmpipe (proved headless in spec 007's harness),
  `runClient` + `runServer` from the PR. Model cost is the only cost; cap it per PR (A4).
- Full pack: the single preview slot on the homelab when it is up (one at a time); nightly at most.

## Decisions for Brian (defaults in bold)
- **A1 Repo** (decided 2026-10-31): **`Arffornia/Arffornia_Playtest`**, public, created by Brian (org naming convention `Arffornia/Arffornia_<Name>`), (probe mod + runner + PR playtest kit; reused by
  the mod and the pack) / inside `Arffornia_Mods` as a subproject.
- **A2 Probe base**: **write our own on NeoForge, copying MCPFabric's tool design** (MIT, credit) /
  port MCPFabric itself / start from computer use only.
- **A3 Trigger**: **label `playtest`, plus automatically when a PR touches machines, network or GUI
  code** / label only / every PR.
- **A4 Budget per PR run**: **60 steps or 20 minutes, Sonnet** / Opus for high-risk PRs only / Haiku
  (too weak for open-ended play, per the research).
- **A5 Gate strength**: **advisory**: failures are posted and the PR stays out of "awaiting Brian"
  until an agent fixes or explains them; never a hard CI block at first / hard block.
- **A6 Promote passing runs to scripted scenarios automatically**: **yes, in the same PR** / ask first.

## Work breakdown
1. Probe skeleton: `observe` (screenshot + state + widget tree) and `command`, headless in CI. (M)
2. `click_widget`, `slot`, `look`, `use`, `time` with `/tick`; scenario templates. (M)
3. Runner + report + scenario export; first run on a real machine PR. (M)
4. `coverage` (JaCoCo diff), screenshot baselines. (M)
5. Full-pack nightly on the preview slot. (S, needs the slot)

## Not verified
- MCPFabric's NeoForge build on 1.21.1; Mineflayer's NeoForge handshake status (from its docs and
  issues, not tried against our server).
- The probe is a sketch; nothing of it was compiled.
