# Launch Prep
**Started:** 2026-04-12
**Status:** COMPLETE

## Group 1 — Ship Blockers
- [x] 1. npm publish readiness — `@driftvane/wotw`, `bin`, `files`, `.npmignore`, shebang verified, `npm pack` clean (20 files, 441 KB), global install + `wotw --version` + `wotw --help` all pass
- [x] 2. README rewrite — paragraph-form, no badges, no bullets, under 120 lines, install in 3 lines, all 10 docs linked
- [x] 3. v0.2.0 release tag prep — CHANGELOG `0.2.0` section (Features/Security/Quality), BUILD-SUMMARY headline current, version reads dynamically from package.json

## Group 2 — Community Readiness
- [x] 4. GitHub issue templates — `bug_report.md` + `feature_request.md`
- [x] 5. PR template — `pull_request_template.md` with 5-gate checklist
- [x] 6. CODEOWNERS — `* @OptionsIQ`
- [x] 7. Pre-commit hooks — husky 9.1.7 + lint-staged 16.4.0, `prettier --write` + `eslint --fix` on `src/**/*.ts` and `test/**/*.ts`

## Verification
- [x] All 5 gates green after changes — typecheck, lint (0 errors, 7 warnings), format, 446/446 tests, build
- [x] `npm pack --dry-run` clean — 20 files, no source `.ts`, no `test/`, no `.github/`, no report `.md`
- [x] `wotw --version` → `0.2.0`, `wotw --help` → all commands listed
