# LICENSE-NOTICES

> **This document is a plain-English summary of the licence on `wotw`.
> It is NOT legal advice. The binding text is in [`LICENSE`](LICENSE).
> When the two disagree, `LICENSE` wins. If you need a confident answer
> for your situation, talk to an attorney who handles open-source licensing.**

## TL;DR

`watcher-on-the-wall` is licensed under **AGPL-3.0-or-later**.

| If you're... | You can... | You must... |
|---|---|---|
| Running `wotw` on your own laptop for your own notes | Anything. Modify, embed, fork. | Nothing extra. The AGPL doesn't trigger. |
| Running `wotw` inside your team / company as an internal tool | Anything. | Nothing extra. Internal use is not "distribution" or "remote interaction." |
| Modifying `wotw` and shipping the binary to other people | Distribute the modified source under AGPL-3.0-or-later. | Make the modified source available to your distributees on request. |
| Modifying `wotw` and offering it as a network service to outsiders | Run a modified version. | **Make the modified source available to every user who interacts with the service** (the AGPL §13 network-use clause). A download link in the UI is the minimum. |
| Building a closed-source SaaS that wraps `wotw` | Use it as-is, unmodified, in a way that's clearly composable rather than entangled. | Read §13 carefully, OR get a commercial licence from 3030 Labs. |
| Forking `wotw` for a competing product | Yes — that's what AGPL allows. | Keep it AGPL-3.0-or-later and ship source to your users. You may not relicense to MIT / BSD / proprietary. |

## What AGPL-3.0-or-later actually requires

The AGPL is the GPL plus one extra rule: **if you offer a modified
version of the program over a network, the people interacting with it
over that network are also entitled to receive the source code**.

In practice this means:

1. **Distribution triggers source-sharing.** If you give someone the
   `wotw` binary (or a modified one), you must offer them the source,
   under AGPL-3.0-or-later, on the same channel or by a clearly
   advertised means (a public Git URL is fine).
2. **Network use triggers source-sharing too.** If your modified
   `wotw` answers an HTTP / MCP request from anyone outside the
   organisation running it, that "anyone outside" is a user, and you
   owe them source. This is the §13 clause and is the meaningful
   difference between AGPL and GPL.
3. **"At a distance" linking still triggers.** Loading `wotw` as a
   library, importing it as a module, or calling into it via an
   internal API does not let you escape the AGPL by claiming "we
   only used the public interface." If your program's normal operation
   requires `wotw` to function, the combined work is derivative.
4. **The licence is one-way ratchet.** Code derived from AGPL `wotw`
   cannot be relicensed under a more permissive licence by anyone
   except the copyright holder (3030 Labs LLC). A fork that strips
   the licence is invalid and unenforceable against your
   downstream users.

## What counts as a "derivative work"

The boring legal answer: courts decide on a case-by-case basis.
The practical answer:

- **Definitely derivative**: you patched `src/`, you replaced a module,
  you rebuilt the daemon with different defaults, you forked the repo
  and renamed it.
- **Definitely derivative**: you wrote a wrapper that statically
  imports `@driftvane/wotw` as an npm dependency and ships the result.
- **Likely derivative**: your service spawns the `wotw` binary as a
  subprocess and depends on its specific output format, and you
  modified that format.
- **Probably not derivative**: your service calls the unmodified
  `wotw` MCP HTTP endpoint as one of many independent backend
  services, the way you'd call any third-party API. Two arms-length
  processes communicating over standard protocols are usually
  separate works, but consult counsel if it matters.

When in doubt: the safer reading is that it IS derivative, and the
honourable thing is to ship source. If you don't want to ship source,
ask for a commercial licence.

## What counts as a "service"

AGPL §13's network-use clause kicks in when "you modify the Program,
your modified version must prominently offer all users interacting
with it remotely through a computer network ... an opportunity to
receive the Corresponding Source."

- **Internal corporate tools** running `wotw` for company employees
  only: typically not a §13 trigger. The users are not "remote" in
  the licence's sense; they're the same organisation that's running
  the daemon.
- **Customer-facing SaaS** running `wotw` for paying customers: §13
  triggers if you've modified `wotw`. Publish a source link on the
  service's UI or in its docs.
- **Public-facing free tool** (no auth, anyone-on-the-internet) running
  `wotw`: §13 triggers if you've modified `wotw`. Same source link
  obligation.
- **An MCP endpoint serving your wiki to your own personal Claude
  Code session**: not a §13 trigger. You're the only user, and you
  have the source already.

## Relationship to `wotw-cloud`

3030 Labs also operates `wotw-cloud`, the control-plane service for
managed `wotw` deployments. **`wotw-cloud` is NOT a derivative work
of `wotw`** under our reading:

- The daemon and the cloud are separate codebases at separate
  repositories with separate licences.
- The cloud calls the daemon over standard MCP / HTTP boundaries it
  did not modify.
- The cloud does not statically link, embed, or contain `wotw` source.
- The two products are released independently and can be operated
  independently.

We share types and the chain-hash algorithm via **CI-enforced
byte-identity vendoring** between repos so that the daemon's
provenance chain is byte-identical with what the cloud emits. This is
not a derivative-work relationship; it's a deliberate interface
contract.

If you fork `wotw` and want to build your own control plane, you
have AGPL-3.0-or-later authority to do that — you're not constrained
by 3030 Labs' commercial offering. The licence is symmetric.

## What competitors can and can't do

**You can:**
- Fork the repo, rebrand it, and run it for your own customers.
- Sell support / consulting / hosting on top of unmodified `wotw`.
- Build a commercial product that interoperates with `wotw` over
  documented public interfaces (MCP, file-system contract,
  provenance-chain format).
- Use the BM25 retrieval design, the Pass A / Pass B context-efficiency
  architecture, or the G5 attestation scheme as inspiration — those
  are technical ideas, not copyrightable expression.

**You can't:**
- Take the AGPL `wotw` source, ship it (modified or not) inside a
  closed-source product without satisfying AGPL §13 / §5.
- Relicense `wotw` source to MIT / BSD / proprietary terms.
- Strip the AGPL notices from files you redistribute.
- Use the `wotw` or `watcher-on-the-wall` name, the wotw.dev
  domain, or the `@driftvane/wotw` npm scope to imply 3030 Labs
  endorsement of your fork (trademark, not copyright — but the same
  obligation applies).

## Commercial licence

If AGPL's network-use clause is incompatible with your business
model, 3030 Labs offers commercial licences that remove the §13
obligation in exchange for an annual fee. Contact
`licensing@3030labs.io`. Common reasons customers ask:

- Embedding `wotw` inside a closed-source SaaS without publishing
  the modifications upstream.
- Operating a fork as a managed service without exposing the fork's
  internal patches.
- Including `wotw` in a customer-deliverable binary that the customer
  cannot legally redistribute to compete.

We do not offer "AGPL with a one-time fee" — the licence is the
licence. The commercial option is a separate, parallel licence that
co-exists with AGPL for users who choose it.

## Third-party dependencies

`wotw` depends on a number of MIT / Apache 2.0 / BSD-licenced npm
packages (see `package.json` for the full list). Those licences travel
with the binary in `node_modules/`; redistributing the `wotw` binary
satisfies them. None of those upstream licences are GPL-incompatible
with AGPL-3.0-or-later, but if you find one that is, please report it
to `legal@3030labs.io`.

The exception is `better-sqlite3`, which is MIT and bundles SQLite
itself (public domain). No additional restriction.

## Patents

3030 Labs LLC has not asserted patents over the `wotw` code. The AGPL
includes an express patent grant from contributors to users (§11). If
you contribute code, you grant the same patent licence on contributed
material to all downstream `wotw` users. This is normal for AGPL
contributions and is enforced by the DCO sign-off in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Trademark

"watcher-on-the-wall", "wotw", "wotw-cloud", "wotw-verify",
"3030 Labs", the wotw.dev domain, and any associated logos are
trademarks of 3030 Labs LLC. The AGPL covers the code, not the
trademark. You may identify your fork ("based on watcher-on-the-wall"),
but you may not call your fork "watcher-on-the-wall" or use the
name in a way that implies 3030 Labs endorsement.

## Where to ask

- General licensing questions: `licensing@3030labs.io`
- Commercial-licence inquiries: `licensing@3030labs.io`
- Trademark inquiries: `legal@3030labs.io`
- Security disclosures: `security@3030labs.io` (see [`SECURITY.md`](SECURITY.md))

---

**Final reminder:** the above is a plain-English summary intended to
help you understand the AGPL in context. It is not legal advice and
does not constitute an attorney-client relationship. If your business
depends on the answer, hire an attorney.
