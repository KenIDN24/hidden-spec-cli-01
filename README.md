[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/KenIDN24/hidden-spec-cli-01/rank.svg)](https://make.fun/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/KenIDN24/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format, built for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122).

`mend` is a command-line tool that applies the edits AI models write — unified diffs (often with
wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON editor calls — to a tree of text
files. It finds the lines each edit names at the first of three matching tiers (exact, trailing
whitespace ignored, indentation ignored with re-indentation), writes every change or none, and
prints what it changed or why it failed. `SPEC.md` is the whole contract.

## Files

- `main.ts` — the CLI. Node 22 and its standard library alone; run as `node main.ts [options] [PATCH]`.
  With `MAKEFUN_ENV_URL` set it hands a trial over to the runner.
- `runner.ts` — the kit's trial runner, kept as it is: reads the checks from the env, runs
  `node main.ts` on each in a fresh directory, and posts the exit code, stdout and files.
- `check.ts` — runs `main.ts` on the public practice set:

      node check.ts <practice.json>

- `SPEC.md` — the specification `mend` implements, sentence by sentence.
- `LICENSE` — MIT.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file, or standard input when absent or `-`. `--format` is one of `unified`,
`search-replace`, `v4a`, `json`, or `auto` (the default) to detect it. `--check` reports the same
result without writing; `--strict` matches lines exactly (tier 0 only).
