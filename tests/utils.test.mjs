import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { importModule } from "./helpers/setup.mjs";

let mergeStopSequences;
let stripCodeFences;
let stripRepeatedContext;

before(async () => {
  const mod = await importModule();
  mergeStopSequences = mod.mergeStopSequences;
  stripCodeFences = mod.stripCodeFences;
  stripRepeatedContext = mod.stripRepeatedContext;
});

describe("mergeStopSequences", () => {
  it("should return default sequences when no client stop", () => {
    const result = mergeStopSequences(undefined);
    assert.deepStrictEqual(result, ["\n\n"]);
  });

  it("should merge client array with defaults", () => {
    const result = mergeStopSequences(["<end>"]);
    assert.deepStrictEqual(result, ["\n\n", "<end>"]);
  });

  it("should merge client string with defaults", () => {
    const result = mergeStopSequences("<end>");
    assert.deepStrictEqual(result, ["\n\n", "<end>"]);
  });

  it("should not duplicate existing sequences", () => {
    const result = mergeStopSequences(["\n\n"]);
    assert.deepStrictEqual(result, ["\n\n"]);
  });

  it("should truncate to 4 sequences", () => {
    const result = mergeStopSequences(["a", "b", "c", "d"]);
    assert.equal(result.length, 4);
  });
});

describe("stripCodeFences", () => {
  it("should strip code fences wrapping the entire output", () => {
    assert.equal(stripCodeFences("```js\ncode\n```"), "code");
  });

  it("should return text unchanged when no fences", () => {
    assert.equal(stripCodeFences("just code"), "just code");
  });

  it("should not strip partial fences", () => {
    const text = "some\n```\ncode\n```\nmore";
    assert.equal(stripCodeFences(text), text);
  });
});

describe("stripRepeatedContext", () => {
  it("should strip prefix tail overlap from content start", () => {
    const result = stripRepeatedContext("world hello", "hello world", "");
    assert.equal(result, " hello");
  });

  it("should strip suffix head overlap from content end", () => {
    const result = stripRepeatedContext("code return", "", "return value");
    assert.equal(result, "code ");
  });

  it("should return content unchanged when no overlap", () => {
    const result = stripRepeatedContext("middle", "before", "after");
    assert.equal(result, "middle");
  });

  it("should handle empty content", () => {
    const result = stripRepeatedContext("", "prefix", "suffix");
    assert.equal(result, "");
  });
});
