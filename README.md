# Arffornia playtest

Everything between "an agent opened a PR" and "Brian says it works in game":

- `kit/`: **one command to test a PR in game**. `playtest guide <pr>` writes the test guide (what
  changed, what to test, what to watch, decisions to report); `playtest up <pr>` starts the server
  and the game for that PR (light env for a single mod, the full pack locally or on the one leased
  preview slot); `playtest report <pr>` posts the verdict in the review-stack answer format.
- `agent/`: **the autonomous playtester**. A dev-only probe mod exposes the game as MCP tools
  (`tools.json`), Claude drives it with `PLAYTESTER.md`, scripted scenarios (`scenarios/`) replay
  passing runs for free.

```sh
node kit/playtest.mjs guide Arffornia/Arffornia_Mods#50
node kit/playtest.mjs up Arffornia/Arffornia_Mods#50 --dry-run
```

Specs: [kit](docs/kit-spec.md), [agent](docs/agent-spec.md). Tech watch: card 02, "Agents that play
the feature".

Rules: free tools only (GitHub-hosted runners, Xvfb + Mesa, self-hosted homelab when it is up).
One full-pack environment at a time; light environments are cheap. The probe mod never ships in
the player pack.

Status: proposed. The kit's `guide` and `report` work; `up` is tested in dry-run only; the probe
mod is a reviewed sketch, not built.
