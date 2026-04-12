/**
 * Unit tests for watcher/event-classifier.ts: EventClassifier.
 */
import { describe, expect, it } from "vitest";
import { EventClassifier } from "../../src/watcher/event-classifier.js";

describe("EventClassifier", () => {
  it("classifies a new file as intent 'new'", () => {
    const classifier = new EventClassifier();
    const result = classifier.classifyAddOrChange("/docs/readme.md", "hello world");
    expect(result.intent).toBe("new");
    expect(result.path).toBe("/docs/readme.md");
    expect(result.previousHash).toBeNull();
    expect(result.currentHash).toEqual(expect.any(String));
  });

  it("classifies an unchanged file as intent 'noop'", () => {
    const classifier = new EventClassifier();
    const contents = "unchanged content";
    // First call seeds the hash
    classifier.classifyAddOrChange("/docs/readme.md", contents);
    // Second call with identical contents
    const result = classifier.classifyAddOrChange("/docs/readme.md", contents);
    expect(result.intent).toBe("noop");
    expect(result.previousHash).toBe(result.currentHash);
  });

  it("classifies a modified file as intent 'update'", () => {
    const classifier = new EventClassifier();
    // Seed with original contents
    classifier.classifyAddOrChange("/docs/readme.md", "version 1");
    // Modify the file
    const result = classifier.classifyAddOrChange("/docs/readme.md", "version 2");
    expect(result.intent).toBe("update");
    expect(result.previousHash).not.toBeNull();
    expect(result.currentHash).not.toBeNull();
    expect(result.previousHash).not.toBe(result.currentHash);
  });
});
