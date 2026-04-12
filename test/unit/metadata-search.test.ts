/**
 * Tests for Feature 2: Richer YAML metadata (domain, scope, key_terms)
 * — frontmatter round-trip, search filtering, and key_terms indexing.
 */
import { describe, expect, it } from "vitest";
import { newPage, parsePage, serializePage } from "../../src/wiki/page.js";
import { WikiSearch } from "../../src/wiki/search.js";
import type { WikiPage } from "../../src/utils/types.js";

function page(title: string, body: string, extra: Partial<WikiPage["frontmatter"]> = {}): WikiPage {
  const slug = title.toLowerCase().replace(/\s+/g, "-");
  return {
    ...newPage(`/wiki/concepts/${slug}.md`, title, "concept", body),
    frontmatter: {
      ...newPage(`/wiki/concepts/${slug}.md`, title, "concept", body).frontmatter,
      ...extra,
    },
  };
}

describe("Frontmatter round-trip", () => {
  it("key_terms array survives parse → serialize → parse", () => {
    const original = page("Deployment Guide", "How to deploy things.", {
      domain: "ops",
      scope: "acme-corp",
      key_terms: ["deploy", "rollout", "ship", "release"],
    });
    const serialized = serializePage(original);
    const roundTripped = parsePage(original.path, serialized);
    expect(roundTripped.frontmatter.domain).toBe("ops");
    expect(roundTripped.frontmatter.scope).toBe("acme-corp");
    expect(roundTripped.frontmatter.key_terms).toEqual(["deploy", "rollout", "ship", "release"]);
  });

  it("omits empty key_terms from serialization", () => {
    const original = page("Empty Terms", "No terms here.");
    const serialized = serializePage(original);
    expect(serialized).not.toContain("key_terms");
    expect(serialized).not.toContain("domain");
    expect(serialized).not.toContain("scope");
  });

  it("consolidated_into survives round-trip", () => {
    const original = page("Old Page", "Consolidated.", {
      status: "consolidated",
      consolidated_into: "wiki/concepts/new-page.md",
    });
    const serialized = serializePage(original);
    const roundTripped = parsePage(original.path, serialized);
    expect(roundTripped.frontmatter.status).toBe("consolidated");
    expect(roundTripped.frontmatter.consolidated_into).toBe("wiki/concepts/new-page.md");
  });
});

describe("Search with domain filter", () => {
  it("returns only matching pages", () => {
    const search = new WikiSearch();
    search.rebuild([
      page("Deployment Guide", "How to deploy apps.", { domain: "ops" }),
      page("Security Policy", "Auth and access control.", { domain: "security" }),
      page("API Design", "REST API patterns.", { domain: "architecture" }),
    ]);
    const hits = search.search("guide", 20, { domain: "ops" });
    expect(hits.length).toBe(1);
    expect(hits[0]!.title).toBe("Deployment Guide");
  });
});

describe("Search without filters", () => {
  it("returns all matching pages (backward compatible)", () => {
    const search = new WikiSearch();
    search.rebuild([
      page("Deployment Guide", "How to deploy apps.", { domain: "ops" }),
      page("Deploy Script", "Automated deploy script.", { domain: "engineering" }),
    ]);
    const hits = search.search("deploy", 20);
    expect(hits.length).toBe(2);
  });
});

describe("key_terms searchability", () => {
  it("key_terms content is searchable via minisearch", () => {
    const search = new WikiSearch();
    search.rebuild([
      page("Deployment Guide", "How to ship software.", {
        key_terms: ["rollout", "release", "ci-cd"],
      }),
    ]);
    // Search for a term that only appears in key_terms, not body or title.
    const hits = search.search("rollout", 20);
    expect(hits.length).toBe(1);
    expect(hits[0]!.title).toBe("Deployment Guide");
  });

  it("synonym in key_terms but not body still returns the page", () => {
    const search = new WikiSearch();
    search.rebuild([
      page("Authentication System", "Login flow using JWT tokens.", {
        key_terms: ["auth", "sso", "oauth", "single-sign-on", "identity"],
      }),
    ]);
    // "sso" appears only in key_terms.
    const hits = search.search("sso", 20);
    expect(hits.length).toBe(1);
    expect(hits[0]!.title).toBe("Authentication System");
  });
});

describe("Search with scope filter", () => {
  it("filters by scope", () => {
    const search = new WikiSearch();
    search.rebuild([
      page("Deployment Guide", "Deploy apps.", { scope: "wotw" }),
      page("API Design", "REST patterns.", { scope: "acme-corp" }),
    ]);
    const hits = search.search("guide design", 20, { scope: "wotw" });
    expect(hits.every((h) => h.title === "Deployment Guide")).toBe(true);
  });
});
