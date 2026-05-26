# Install evidence — macOS arm64 (manual capture runbook)

This file is the runbook the operator pastes into and commits.
The CI-driven workflow at `.github/workflows/install-evidence.yml`
covers macOS amd64 / Linux / Windows; macOS arm64 is captured here
because (a) it's the majority of Apple developer machines since 2020
and (b) the manual run exercises real-LLM ingestion that the
keyless CI runs cannot.

## How to capture (operator runbook)

On a clean machine — or after `npm uninstall -g @driftvane/wotw` to
make this clean — paste the block below. The script captures stdout
to `evidence.log` for committing.

```bash
# 1. Confirm starting state
echo "## starting state ##" > evidence.log
uname -a >> evidence.log
node --version >> evidence.log
npm --version >> evidence.log
echo "" >> evidence.log

# 2. Install
echo "## npm install ##" >> evidence.log
npm install -g @driftvane/wotw 2>&1 | tee -a evidence.log
echo "" >> evidence.log
echo "wotw --version:" >> evidence.log
wotw --version 2>&1 | tee -a evidence.log
echo "" >> evidence.log

# 3. Init in a scratch directory
SCRATCH="$HOME/wotw-arm64-evidence-$(date +%s)"
mkdir "$SCRATCH"
echo "## wotw init in $SCRATCH ##" >> evidence.log
wotw init --path "$SCRATCH" --yes --no-open 2>&1 | tee -a evidence.log
echo "" >> evidence.log

# 4. Drop the 5 sample files
echo "## drop 5 sample files ##" >> evidence.log
WOTW_REPO_PATH="${WOTW_REPO_PATH:-$HOME/watcher-on-the-wall}"
cp "$WOTW_REPO_PATH/docs/install-evidence/fixtures/sample-1.md" "$SCRATCH/raw/"
cp "$WOTW_REPO_PATH/docs/install-evidence/fixtures/sample-2.md" "$SCRATCH/raw/"
cp "$WOTW_REPO_PATH/docs/install-evidence/fixtures/sample-3.md" "$SCRATCH/raw/"
cp "$WOTW_REPO_PATH/docs/install-evidence/fixtures/sample-4.md" "$SCRATCH/raw/"
cp "$WOTW_REPO_PATH/docs/install-evidence/fixtures/sample-5.md" "$SCRATCH/raw/"
ls -la "$SCRATCH/raw/" >> evidence.log
echo "" >> evidence.log

# 5. Start the daemon (claude CLI must be on PATH, OR
#    ANTHROPIC_API_KEY must be exported before this step)
echo "## wotw start ##" >> evidence.log
wotw start 2>&1 | tee -a evidence.log
echo "" >> evidence.log

# 6. Watch for wiki pages to appear (give it 60 seconds)
echo "## waiting 60s for ingestion ##" >> evidence.log
sleep 60
echo "## wiki layout after ingestion ##" >> evidence.log
find "$SCRATCH/wiki" -type f | sort >> evidence.log
echo "" >> evidence.log

# 7. Sample one generated page
FIRST_PAGE=$(find "$SCRATCH/wiki" -type f -name '*.md' ! -name 'index.md' ! -name 'log.md' | head -1)
if [ -n "$FIRST_PAGE" ]; then
  echo "## sample generated page: $FIRST_PAGE ##" >> evidence.log
  cat "$FIRST_PAGE" >> evidence.log
  echo "" >> evidence.log
fi

# 8. Verify provenance chain
echo "## wotw audit ##" >> evidence.log
wotw audit --path "$SCRATCH" 2>&1 | tee -a evidence.log
echo "" >> evidence.log

# 9. Stop the daemon
echo "## wotw stop ##" >> evidence.log
wotw stop 2>&1 | tee -a evidence.log
echo "" >> evidence.log

# 10. Show evidence.log for committing
cat evidence.log
```

Also take a **screenshot** of the terminal at step 5 (the
"daemon running" output, with the Terminal.app title bar visible
to confirm the host machine). Save as `macos-arm64-screenshot.png`
in this directory.

After the run completes:

```bash
# Move evidence into the repo
mv evidence.log "$WOTW_REPO_PATH/docs/install-evidence/macos-arm64-raw.log"
# Then paste the relevant sections into the template block below.
```

---

## Captured evidence — v0.8.4 (placeholder until first manual run)

**Platform:** macOS arm64 (Apple Silicon)
**Runner:** Operator's MacBook (model + macOS version to be filled
in on first run)
**Shell:** `zsh`
**Node:** `<to-be-filled>`
**Date (UTC):** `<to-be-filled>`
**Package version:** `@driftvane/wotw@0.8.4`

> **STATUS: pending operator's first manual capture after v0.8.4 publishes
> to npm.** The runbook above is the script to use. Until then, this
> section is a placeholder and the GH-hosted `macos-14` arm64 evidence
> from the install-evidence workflow stands in.

### npm install

```
(placeholder — paste the verbatim npm install output here after capture)
```

### wotw init

```
(placeholder — paste the wotw init output here after capture)
```

### Wiki output (5-file drop, real LLM ingest)

```
(placeholder — paste the find-output of wiki/ + one sample page here)
```

### Provenance chain audit

```
(placeholder — paste the wotw audit output here)
```

### Screenshot

`macos-arm64-screenshot.png` — to be added on first manual run.

### Notes

- (placeholder — anything platform-specific worth flagging)

---

## Why a manual run vs purely CI

Reasons macOS arm64 evidence is captured manually instead of relying
entirely on the GH-hosted `macos-14` runner:

1. **Real LLM ingestion exercise.** CI runs cannot expose an
   Anthropic key (or claude CLI session) without leaking it across
   the public log surface. A manual run on the operator's machine,
   with their own subscription credentials, captures the full
   end-to-end ingestion — not just the "daemon starts cleanly" smoke.
2. **Genuine first-time-install conditions.** The CI runner clears
   its cache between runs but is still a managed environment with
   pre-warmed Homebrew taps, Xcode tools, etc. A manual run on a
   regular user laptop is closer to what a stranger experiences.
3. **Audit chain confidence.** `wotw audit --json` after a real
   ingestion is the strongest evidence that the substrate + Pass A/B
   retrieval + provenance chain actually function together on the
   primary platform. CI exercises the same code paths, but the
   manual run is the one that ships with the human stamp.

The GH-hosted `macos-14` evidence (from the install-evidence
workflow) is still useful — it confirms install + init + scaffold +
status — but it doesn't replace this manual run.
