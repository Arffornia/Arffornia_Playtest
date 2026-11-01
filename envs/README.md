# envs: one file per playtest slot

This branch holds only `envs/<slot>.yaml` files (`pr1`, `pr2`, `pr3`, `slot`). Argo CD
(TheGostsniperfr/infra, ApplicationSets `playtest-website` and `playtest-pack`) deploys one
environment per file. With no `slot.yaml`, the test slot runs `main` with the `edge` mod.

Write them with the `playtest` CLI from `main` (`playtest up|extend|down`), never by hand.
Every write is a normal commit with a blob-SHA check; nothing here is ever force-pushed.
The reaper (`main`, `.github/workflows/reap.yml`) removes expired and closed ones.
