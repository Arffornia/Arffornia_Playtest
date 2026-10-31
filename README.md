# Arffornia playtest

Everything between "an agent opened a PR" and "Brian says it works in game":

- `kit/`: **one command to test a PR in game**. `playtest guide <pr>` writes the test guide (what
  changed, what to test, what to watch, decisions to report); `playtest up <pr>` starts the server
  and the game for that PR (light env for a single mod, the full pack locally or on the one leased
  preview slot); `playtest report <pr>` posts the verdict in the review-stack answer format.
- `agent/`: **the autonomous playtester**. A dev-only probe mod exposes the game as MCP tools
  (`tools.json`), Claude drives it with `PLAYTESTER.md`, scripted scenarios (`scenarios/`) replay
  passing runs for free.

## Install the `playtest` command

`playtest` is a command-line tool (Node 20+, no dependencies). It calls `gh` (logged in) and `git`,
and Java 21 for local environments. Pick one way:

```sh
# Nix (NixOS, or any machine with flakes): run it once, or install it in your profile
nix run github:Arffornia/Arffornia_Playtest -- up Arffornia/Arffornia_Mods#50
nix profile install github:Arffornia/Arffornia_Playtest

# npm (any OS): installs the `playtest` command globally from this repo
npm install -g github:Arffornia/Arffornia_Playtest

# or straight from a clone, no install
node kit/playtest.mjs up Arffornia/Arffornia_Mods#50
```

On NixOS you can also add it to your system: take `packages.<system>.playtest` from this flake as
an input of your configuration.

## Use it

```sh
playtest guide  Arffornia/Arffornia_Mods#50            # what changed, what to test, what to watch
playtest up     Arffornia/Arffornia_Mods#50            # start server + game for that PR (light env)
playtest up     Arffornia/Arffornia_Mods#50 --dry-run  # print the steps only
playtest down                                          # stop it (one environment at a time)
playtest report Arffornia/Arffornia_Mods#50 --verdict ok --post
```

A PR URL works too (`playtest up https://github.com/Arffornia/Arffornia_Mods/pull/50`).

Specs: [kit](docs/kit-spec.md), [agent](docs/agent-spec.md). Tech watch: card 02, "Agents that play
the feature".

Rules: free tools only (GitHub-hosted runners, Xvfb + Mesa, self-hosted homelab when it is up).
One full-pack environment at a time; light environments are cheap. The probe mod never ships in
the player pack.

Status: proposed. The kit's `guide` and `report` work; `up` is tested in dry-run only; the probe
mod is a reviewed sketch, not built.
