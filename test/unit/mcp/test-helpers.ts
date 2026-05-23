/**
 * Shared test helpers for MCP-tool unit tests. Provides a quick way to
 * stand up a temp wiki root + WikiStore + WikiSearch index, write a few
 * canonical pages, and return the trio ready for use.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, resolveConfigPaths } from "../../../src/daemon/config.js";
import { loadAllPages } from "../../../src/ingestion/wiki-writer.js";
import { newPage, serializePage } from "../../../src/wiki/page.js";
import { WikiSearch } from "../../../src/wiki/search.js";
import { WikiStore } from "../../../src/wiki/store.js";
import type { WotwConfig } from "../../../src/utils/types.js";

export interface MiniWiki {
  wikiRoot: string;
  store: WikiStore;
  search: WikiSearch;
  config: WotwConfig;
}

/** Create a temp dir + WikiStore + empty search index. */
export function makeMiniWiki(): MiniWiki {
  const wikiRoot = mkdtempSync(join(tmpdir(), "wotw-mcp-test-"));
  const store = new WikiStore({ wikiRoot });
  mkdirSync(join(wikiRoot, "wiki", "concepts"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "entities"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "sources"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "comparisons"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "syntheses"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "queries"), { recursive: true });
  const search = new WikiSearch();
  const config = resolveConfigPaths(defaultConfig(), wikiRoot);
  config.wiki_root = wikiRoot;
  config.query.expand = false;
  return { wikiRoot, store, search, config };
}

export async function addPage(
  wiki: MiniWiki,
  category: "concept" | "entity" | "source" | "comparison" | "synthesis" | "query",
  slug: string,
  title: string,
  body: string,
): Promise<string> {
  const dir = wiki.store.categoryDir(category);
  const path = join(dir, `${slug}.md`);
  const page = newPage(path, title, category, body);
  writeFileSync(page.path, serializePage(page));
  return page.path;
}

export async function rebuildIndex(wiki: MiniWiki): Promise<void> {
  const pages = await loadAllPages(wiki.store);
  wiki.search.rebuild(pages);
}

/** Wiki containing photosynthesis + Rust borrow checker pages (F1, F4). */
export async function loadCanonicalFixtures(wiki: MiniWiki): Promise<void> {
  await addPage(
    wiki,
    "concept",
    "photosynthesis",
    "Photosynthesis",
    `## Definition

Photosynthesis is the process by which green plants and some other organisms use sunlight to synthesize foods with the aid of chlorophyll pigments inside their leaves. The reaction converts water and carbon dioxide into glucose and oxygen.

## Light reactions

The light-dependent reactions take place in the thylakoid membrane of the chloroplast and produce ATP and NADPH that fuel the next stage. Chlorophyll absorbs photons primarily in the red and blue wavelengths.

## Calvin cycle

The Calvin cycle uses ATP and NADPH from the light reactions to fix CO2 into glucose. RuBisCO is the key enzyme that catalyses this carbon fixation step.

## Significance

Photosynthesis is the basis of nearly all food chains on Earth and is responsible for the oxygen in the atmosphere.`,
  );
  await addPage(
    wiki,
    "concept",
    "rust-borrow-checker",
    "Rust Borrow Checker",
    `## Overview

The Rust borrow checker is a compile-time mechanism that enforces ownership and borrowing rules to prevent data races and memory safety bugs without a garbage collector.

## Ownership rules

Each value has a single owner, and the value is dropped when the owner goes out of scope. Ownership can be moved or borrowed; references can be either shared (&T) or exclusive (&mut T) but never both at once for the same value.

## Lifetimes

Lifetimes are annotations that the borrow checker uses to verify that references do not outlive their referents. Most lifetimes are elided by the compiler using a fixed set of rules.

## Common errors

The classic borrow-checker error is attempting to take a mutable reference while a shared reference is still active. Refactoring code to split borrows or restrict scope usually resolves these errors.`,
  );
  await rebuildIndex(wiki);
}

/** Build a small ~10-page corpus for the small-corpus benchmark. */
export async function loadSmallCorpus(wiki: MiniWiki): Promise<void> {
  await loadCanonicalFixtures(wiki);
  const more: Array<[string, string, string]> = [
    [
      "chlorophyll",
      "Chlorophyll",
      "Chlorophyll is the green pigment that absorbs light for photosynthesis.",
    ],
    [
      "mitochondria",
      "Mitochondria",
      "Mitochondria are the powerhouses of the cell, generating ATP via cellular respiration.",
    ],
    ["dna", "DNA", "DNA stores genetic information using four nucleotide bases."],
    ["bm25", "BM25", "BM25 is a probabilistic retrieval scoring function over inverted indexes."],
    ["tcp", "TCP", "TCP is a reliable, ordered byte-stream transport protocol over IP."],
    ["raft", "Raft Consensus", "Raft is a consensus algorithm for replicated state machines."],
    [
      "graphql",
      "GraphQL",
      "GraphQL is a query language for APIs with a single endpoint and typed schema.",
    ],
    [
      "rust-lifetimes",
      "Rust Lifetimes",
      "Lifetimes in Rust annotate references so the borrow checker can validate them.",
    ],
  ];
  for (const [slug, title, body] of more) {
    await addPage(wiki, "concept", slug, title, body);
  }
  await rebuildIndex(wiki);
}

/** Build a ~100-page corpus for the large-corpus benchmark. */
export async function loadLargeCorpus(wiki: MiniWiki): Promise<void> {
  await loadSmallCorpus(wiki);
  // Add 90 more synthetic concept pages so the BM25 index has scale.
  for (let i = 0; i < 90; i++) {
    await addPage(
      wiki,
      "concept",
      `topic-${i}`,
      `Topic ${i}`,
      `## Overview\n\nTopic number ${i} discusses concept ${i} in the broader knowledge wiki. ` +
        `It is related to topic ${(i + 1) % 90}. ` +
        `\n\n## Details\n\n${"Topic content padding. ".repeat(20)}`,
    );
  }
  await rebuildIndex(wiki);
}
