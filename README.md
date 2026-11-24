# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ariswowo/hidden-spec-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ariswowo/hidden-spec-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — and `mend` reads each as `SPEC.md` says, finds the lines at the first
of three matching tiers, and writes every change or none.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory; when absent
  or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects it.
- `--check` does everything but write.
- `--strict` matches lines exactly (tier 0 only).

Node 22, standard library only. See `SPEC.md` for the full contract.

## Entry

Built for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
("Build mend, one patch tool for every AI edit format").
