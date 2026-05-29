# Install evidence

Captures of the canonical `npm install -g @3030-labs/wotw` flow on
each supported platform. **One file per platform-tier per release.**

| Platform | Tier | Captured by | Current evidence |
|---|---|---|---|
| macOS arm64 (Apple Silicon) | Primary | Manual run on operator's Mac | [`macos-arm64.md`](./macos-arm64.md) |
| macOS amd64 (Intel) | Primary | GH Actions `install-evidence.yml` | [`macos-amd64.md`](./macos-amd64.md) |
| Linux amd64 | Primary | GH Actions `install-evidence.yml` | [`linux-amd64.md`](./linux-amd64.md) |
| Windows amd64 | Primary | GH Actions `install-evidence.yml` (PowerShell) | [`windows-amd64.md`](./windows-amd64.md) |

`fixtures/sample-1.md` through `fixtures/sample-5.md` are the 5
markdown files dropped into `raw/` to exercise the ingestion pipeline.

## How the evidence is captured

After a release ships to npm:

1. **macOS arm64**: operator runs the script in
   [`macos-arm64.md`](./macos-arm64.md) on their own MacBook (since
   GH-hosted `macos-14` is arm64 but the manual run also captures a
   real-LLM ingestion that CI can't do without exposing an
   Anthropic key). Output is pasted into `macos-arm64.md`.
2. **macOS amd64 / Linux amd64 / Windows amd64**: the
   `install-evidence.yml` GitHub Actions workflow fires automatically
   on tag push. Each platform installs the npm package, runs `wotw
   init`, drops 5 markdown files, and uploads a per-platform evidence
   artifact. An operator promotes the artifacts into this directory
   via a follow-up commit.

The GH Actions runs do NOT exercise real LLM ingestion (no Anthropic
key in CI). They verify install + init + scaffold + status; the
"daemon writes wiki pages from real LLM" end of the flow is captured
in the macOS arm64 manual run.

## Why this matters

A stranger lands on the repo, copies the README's install line, and
expects it to work. PASS-023 sets the discipline that we commit
positive evidence of this working — on 4 platforms, with passing
logs and at least one full LLM-backed pass — before announcing the
project publicly.

When a platform's evidence is older than the current released version,
that's a debt. The badge at the top of the README should signal which
platforms are stale vs current.

## Layout per file

Each `<platform>.md` file follows the same template:

```
# Install evidence — <platform>

**Platform:** <platform>
**Runner:** <runner image or local machine description>
**Shell:** <bash / zsh / pwsh>
**Node:** <output of `node --version`>
**Date (UTC):** <iso 8601>
**Package version:** @3030-labs/wotw@<version>

## npm install
```
<verbatim install log>
```

## wotw init
```
<verbatim init log>
```

## Wiki output (5-file drop)
```
<directory listing + page contents OR cli-ingest-skipped note>
```

## Notes
- <anything platform-specific worth flagging>
```

The platform `.md` files are intended to be human-readable and
human-archived. The fixtures are the source files; the platform
files are the captured outputs.
