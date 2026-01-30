import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { importModule } from "./helpers/setup.mjs";

let buildFIMPrompt;
let buildFIMMessages;

before(async () => {
  const mod = await importModule();
  buildFIMPrompt = mod.buildFIMPrompt;
  buildFIMMessages = mod.buildFIMMessages;
});

describe("buildFIMPrompt", () => {
  it("should build FIM prompt from prefix and suffix", () => {
    const result = buildFIMPrompt("hello", "world");
    assert.equal(result, "Fill in the missing code at the cursor position.\n\n<|fim_prefix|>hello<|fim_suffix|>world<|fim_middle|>");
  });

  it("should handle empty strings", () => {
    const result = buildFIMPrompt("", "");
    assert.equal(result, "Fill in the missing code at the cursor position.\n\n<|fim_prefix|><|fim_suffix|><|fim_middle|>");
  });

  it("should include inputExtra context using fim_separator tokens", () => {
    const extra = [{ filename: "utils.py", text: "def helper():\n    return 42" }];
    const result = buildFIMPrompt("hello", "world", extra);
    assert.ok(result.includes("<|file_separator|>utils.py\n"));
    assert.ok(result.includes("def helper():\n    return 42"));
    // Extra context should appear inside FIM prefix
    const extraIdx = result.indexOf("<|file_separator|>utils.py");
    const prefixIdx = result.indexOf("<|fim_prefix|>");
    const suffixIdx = result.indexOf("<|fim_suffix|>");
    assert.ok(extraIdx > prefixIdx);
    assert.ok(extraIdx < suffixIdx);
  });

  it("should include filename using fim_separator token", () => {
    const result = buildFIMPrompt("hello", "world", [], "main.py");
    assert.ok(result.includes("<|file_separator|>main.py\n"));
    const sepIdx = result.indexOf("<|file_separator|>main.py");
    const suffixIdx = result.indexOf("<|fim_suffix|>");
    assert.ok(sepIdx < suffixIdx);
  });

  it("should include both inputExtra and filename", () => {
    const extra = [{ filename: "utils.py", text: "import os" }];
    const result = buildFIMPrompt("code", "end", extra, "main.py");
    assert.ok(result.includes("<|file_separator|>utils.py\n"));
    assert.ok(result.includes("<|file_separator|>main.py\n"));
    assert.ok(result.includes("code<|fim_suffix|>end<|fim_middle|>"));
    // Extra files should appear before current file
    const extraIdx = result.indexOf("<|file_separator|>utils.py");
    const fileIdx = result.indexOf("<|file_separator|>main.py");
    assert.ok(extraIdx < fileIdx);
  });

  it("should handle multiple inputExtra entries", () => {
    const extra = [
      { filename: "a.py", text: "aaa" },
      { filename: "b.py", text: "bbb" },
    ];
    const result = buildFIMPrompt("x", "y", extra);
    assert.ok(result.includes("<|file_separator|>a.py\n"));
    assert.ok(result.includes("<|file_separator|>b.py\n"));
    assert.ok(result.includes("aaa"));
    assert.ok(result.includes("bbb"));
  });

  it("should be backward compatible without new params", () => {
    const withParams = buildFIMPrompt("hello", "world", [], "");
    const without = buildFIMPrompt("hello", "world");
    assert.equal(withParams, without);
  });
});

describe("buildFIMMessages", () => {
  it("should return system and user messages with FIM tokens", () => {
    const messages = buildFIMMessages("const x = ", ";");
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "system");
    assert.ok(messages[0].content.includes("Fill-in-the-Middle (FIM)"));
    assert.ok(messages[0].content.includes("<|fim_prefix|>"));
    assert.ok(messages[0].content.includes("<|file_separator|>"));
    assert.equal(messages[1].role, "user");
    assert.ok(messages[1].content.includes("<|fim_prefix|>"));
    assert.ok(messages[1].content.includes("const x = "));
    assert.ok(messages[1].content.includes("<|fim_suffix|>"));
    assert.ok(messages[1].content.includes(";"));
    assert.ok(messages[1].content.includes("<|fim_middle|>"));
  });

  it("should handle empty suffix via system prompt rules", () => {
    const messages = buildFIMMessages("function foo() {", "");
    assert.equal(messages[1].role, "user");
    // Empty suffix case is handled by system prompt, not a special user message hint
    assert.ok(messages[0].content.includes("suffix is empty"));
    assert.ok(messages[1].content.includes("<|fim_suffix|>"));
    assert.ok(messages[1].content.includes("<|fim_middle|>"));
  });

  it("should NOT have empty-suffix hint in user message", () => {
    const messages = buildFIMMessages("function foo() {", "");
    assert.ok(!messages[1].content.includes("suffix is empty"));
  });

  it("should include inputExtra using fim_separator tokens", () => {
    const extra = [{ filename: "utils.py", text: "def helper():\n    return 42" }];
    const messages = buildFIMMessages("const x = ", ";", extra);
    const user = messages[1].content;
    assert.ok(user.includes("<|file_separator|>utils.py\n"));
    assert.ok(user.includes("def helper():\n    return 42"));
    // Extra context should appear between fim_prefix and fim_suffix
    const extraIdx = user.indexOf("<|file_separator|>utils.py");
    const prefixIdx = user.indexOf("<|fim_prefix|>");
    const suffixIdx = user.indexOf("<|fim_suffix|>");
    assert.ok(extraIdx > prefixIdx);
    assert.ok(extraIdx < suffixIdx);
  });

  it("should show filename using fim_separator token", () => {
    const messages = buildFIMMessages("const x = ", ";", [], "main.js");
    const user = messages[1].content;
    assert.ok(user.includes("<|file_separator|>main.js\n"));
    const sepIdx = user.indexOf("<|file_separator|>main.js");
    const suffixIdx = user.indexOf("<|fim_suffix|>");
    assert.ok(sepIdx < suffixIdx);
  });

  it("should include both inputExtra and filename", () => {
    const extra = [{ filename: "utils.py", text: "import os" }];
    const messages = buildFIMMessages("code", "end", extra, "main.py");
    const user = messages[1].content;
    assert.ok(user.includes("<|file_separator|>utils.py\n"));
    assert.ok(user.includes("<|file_separator|>main.py\n"));
    assert.ok(user.includes("<|fim_prefix|>"));
    assert.ok(user.includes("code"));
    assert.ok(user.includes("<|fim_suffix|>"));
    assert.ok(user.includes("end"));
    assert.ok(user.includes("<|fim_middle|>"));
    // Extra files should appear before current file
    const extraIdx = user.indexOf("<|file_separator|>utils.py");
    const fileIdx = user.indexOf("<|file_separator|>main.py");
    assert.ok(extraIdx < fileIdx);
  });

  it("should handle multiple inputExtra entries", () => {
    const extra = [
      { filename: "a.py", text: "aaa" },
      { filename: "b.py", text: "bbb" },
    ];
    const messages = buildFIMMessages("x", "y", extra);
    const user = messages[1].content;
    assert.ok(user.includes("<|file_separator|>a.py\n"));
    assert.ok(user.includes("<|file_separator|>b.py\n"));
    assert.ok(user.includes("aaa"));
    assert.ok(user.includes("bbb"));
  });

  it("should be backward compatible without new params", () => {
    const withParams = buildFIMMessages("const x = ", ";", [], "");
    const without = buildFIMMessages("const x = ", ";");
    assert.deepStrictEqual(withParams, without);
  });
});
