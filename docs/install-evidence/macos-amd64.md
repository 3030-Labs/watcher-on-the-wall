# Install evidence — macos-amd64

**Platform:** macos-amd64
**Runner:** macos-15-intel
**Shell:** bash
**Node:** v22.22.3
**Date (UTC):** 2026-05-29T21:13:44Z
**Package version:** @3030-labs/wotw@0.8.4
**Runner image label:** macos-15-intel

## npm install
```
npm warn deprecated prebuild-install@7.1.3: No longer maintained. Please contact the author of the relevant native addon; alternatives are available.

added 243 packages in 29s

75 packages are looking for funding
  run `npm fund` for details
```

## wotw init
```
⚠ No runtime detected. Install `claude` CLI (https://docs.claude.com/claude-code) or set ANTHROPIC_API_KEY.
✔ Wiki initialized at /Users/runner/work/watcher-on-the-wall/watcher-on-the-wall/scratch-vault

1. Drop source files into raw/
2. wotw start                    # Launch the Watcher
3. wotw status                   # Check it's running
4. wotw query "your question"    # Ask your wiki anything

(Advanced) wotw install-hook     # Auto-start with Claude Code sessions

The Watcher is ready. It will handle the rest.
```

## wotw status (no LLM key in CI)
```
[wotw] no wotw.yaml found — using all defaults (auth disabled, max_daily_usd: 10.0)
{
  "running": false,
  "pid": null,
  "stale_pid_file": false,
  "started_at": null,
  "uptime_seconds": null,
  "config_path": null,
  "wiki_root": "/Users/runner/work/watcher-on-the-wall/watcher-on-the-wall/wiki-store",
  "raw_path": "/Users/runner/work/watcher-on-the-wall/watcher-on-the-wall/wiki-store/raw",
  "server": {
    "host": "127.0.0.1",
    "port": 8787
  },
  "stats": {
    "wiki_pages": 0,
    "orphaned_pages": 0,
    "raw_files": 0,
    "provenance_records": 0,
    "failed_batches": 0,
    "cost_today_usd": 0
  }
}
---
total 24
drwxr-xr-x  10 runner  staff   320 May 29 21:13 .
drwxr-xr-x  76 runner  staff  2432 May 29 21:13 ..
drwxr-xr-x  12 runner  staff   384 May 29 21:13 .git
-rw-r--r--   1 runner  staff   228 May 29 21:13 .gitignore
drwxr-xr-x   5 runner  staff   160 May 29 21:13 .obsidian
drwxr-xr-x   3 runner  staff    96 May 29 21:13 candidates
-rw-r--r--   1 runner  staff  3312 May 29 21:13 CLAUDE.md
drwxr-xr-x   7 runner  staff   224 May 29 21:13 raw
drwxr-xr-x  11 runner  staff   352 May 29 21:13 wiki
-rw-r--r--   1 runner  staff   439 May 29 21:13 wotw.yaml
```

## Vault layout after init + 5-file drop
```
scratch-vault/.git/COMMIT_EDITMSG
scratch-vault/.git/config
scratch-vault/.git/description
scratch-vault/.git/HEAD
scratch-vault/.git/hooks/applypatch-msg.sample
scratch-vault/.git/hooks/commit-msg.sample
scratch-vault/.git/hooks/fsmonitor-watchman.sample
scratch-vault/.git/hooks/post-update.sample
scratch-vault/.git/hooks/pre-applypatch.sample
scratch-vault/.git/hooks/pre-commit.sample
scratch-vault/.git/hooks/pre-merge-commit.sample
scratch-vault/.git/hooks/pre-push.sample
scratch-vault/.git/hooks/pre-rebase.sample
scratch-vault/.git/hooks/pre-receive.sample
scratch-vault/.git/hooks/prepare-commit-msg.sample
scratch-vault/.git/hooks/push-to-checkout.sample
scratch-vault/.git/hooks/sendemail-validate.sample
scratch-vault/.git/hooks/update.sample
scratch-vault/.git/index
scratch-vault/.git/info/exclude
scratch-vault/.git/logs/HEAD
scratch-vault/.gitignore
scratch-vault/.obsidian/app.json
scratch-vault/.obsidian/appearance.json
scratch-vault/.obsidian/graph.json
scratch-vault/CLAUDE.md
scratch-vault/raw/sample-1.md
scratch-vault/raw/sample-2.md
scratch-vault/raw/sample-3.md
scratch-vault/raw/sample-4.md
scratch-vault/raw/sample-5.md
scratch-vault/wiki/getting-started.md
scratch-vault/wiki/index.md
scratch-vault/wiki/log.md
scratch-vault/wotw.yaml
```

_cli-ingest-skipped: no_llm_key_in_ci. Real ingestion requires_
_an Anthropic / OpenAI / Gemini key or a local Ollama runtime._
_See docs/install-evidence/macos-arm64.md for the manual_
_full-ingest evidence captured on Justin's laptop._
