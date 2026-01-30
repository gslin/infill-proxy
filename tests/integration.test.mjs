import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { importModule, readBody, startMockServer } from "./helpers/setup.mjs";

let proxyServer;
let mockServer;
let proxyPort;
let mockHandler;

before(async () => {
  const handlerRef = { get current() { return mockHandler; } };
  const mock = await startMockServer(handlerRef);
  mockServer = mock.server;

  const mod = await importModule({
    OPENAI_ENDPOINT: `http://127.0.0.1:${mock.port}/v1`,
  });
  proxyServer = mod.server;

  proxyPort = await new Promise((resolve) => {
    proxyServer.listen(0, () => {
      resolve(proxyServer.address().port);
    });
  });
});

after(async () => {
  await new Promise((resolve) => proxyServer.close(resolve));
  await new Promise((resolve) => mockServer.close(resolve));
});

function proxyFetch(path, opts) {
  return fetch(`http://127.0.0.1:${proxyPort}${path}`, opts);
}

describe("HTTP integration", () => {
  it("GET /v1/models should return configured model", async () => {
    const res = await proxyFetch("/v1/models");
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.object, "list");
    assert.equal(json.data[0].id, "test-model");
    assert.equal(json.data[0].object, "model");
  });

  it("POST /infill non-stream chat mode should send chat completions format", async () => {
    mockHandler = async (req, res) => {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers["authorization"], "Bearer test-key");

      const body = JSON.parse(await readBody(req));
      assert.equal(body.model, "test-model");
      assert.ok(Array.isArray(body.messages));
      assert.equal(body.messages[0].role, "system");
      assert.equal(body.messages[1].role, "user");
      assert.ok(body.messages[1].content.includes("<|fim_prefix|>"));
      assert.ok(body.messages[1].content.includes("hello"));
      assert.ok(body.messages[1].content.includes("<|fim_suffix|>"));
      assert.ok(body.messages[1].content.includes("world"));
      assert.ok(body.messages[1].content.includes("<|fim_middle|>"));
      assert.equal(body.temperature, 1);
      // stop should merge defaults with client-provided
      assert.ok(Array.isArray(body.stop));
      assert.ok(body.stop.includes("\n\n"));
      assert.ok(body.stop.includes("<end>"));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "generated code  \n" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    };

    const res = await proxyFetch("/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_prefix: "hello",
        input_suffix: "world",
        n_predict: 100,
        temperature: 0.5,
        stop: ["<end>"],
      }),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    // TRIM_RESPONSE should trimEnd the content
    assert.equal(json.content, "generated code");
    assert.equal(json.tokens_evaluated, 10);
    assert.equal(json.tokens_predicted, 5);
  });

  it("POST /infill stream chat mode should return llama.cpp SSE format", async () => {
    mockHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"chunk1"},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"chunk2"},"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    };

    const res = await proxyFetch("/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_prefix: "test",
        input_suffix: "",
        stream: true,
      }),
    });

    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type").includes("text/event-stream"));

    const text = await res.text();
    const events = text.split("\n\n").filter((e) => e.startsWith("data: "));

    const first = JSON.parse(events[0].slice(6));
    assert.equal(first.content, "chunk1");
    assert.equal(first.stop, false);

    const second = JSON.parse(events[1].slice(6));
    assert.equal(second.content, "chunk2");
    assert.equal(second.stop, true);
  });

  it("POST /infill stream should handle SSE without space after data:", async () => {
    mockHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // No space after "data:" — some providers use this format
      res.write('data:{"choices":[{"delta":{"content":"no-space"},"finish_reason":null}]}\n\n');
      res.write('data:{"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n');
      res.write("data:[DONE]\n\n");
      res.end();
    };

    const res = await proxyFetch("/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_prefix: "test",
        input_suffix: "",
        stream: true,
      }),
    });

    assert.equal(res.status, 200);
    const text = await res.text();
    const events = text.split("\n\n").filter((e) => e.startsWith("data: "));

    const first = JSON.parse(events[0].slice(6));
    assert.equal(first.content, "no-space");
    assert.equal(first.stop, false);

    const second = JSON.parse(events[1].slice(6));
    assert.equal(second.content, "done");
    assert.equal(second.stop, true);
  });

  it("POST /infill invalid JSON should return 400", async () => {
    const res = await proxyFetch("/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{{{",
    });

    assert.equal(res.status, 400);
    const json = await res.json();
    assert.ok(json.error.message.includes("Invalid JSON"));
  });

  it("GET /unknown should return 404", async () => {
    const res = await proxyFetch("/unknown");
    assert.equal(res.status, 404);
  });

  it("upstream error should return 502", async () => {
    mockHandler = (_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    };

    const res = await proxyFetch("/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_prefix: "test", input_suffix: "" }),
    });

    assert.equal(res.status, 502);
  });

  it("POST /infill should strip code fences from response", async () => {
    mockHandler = async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "```javascript\nconsole.log('hi');\n```" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }));
    };

    const res = await proxyFetch("/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_prefix: "function foo() {",
        input_suffix: "}",
      }),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.content, "console.log('hi');");
  });

  it("POST /infill with input_extra should include extra context in messages", async () => {
    mockHandler = async (req, res) => {
      const body = JSON.parse(await readBody(req));
      const userMsg = body.messages[1].content;
      assert.ok(userMsg.includes("<|file_separator|>helpers.py\n"));
      assert.ok(userMsg.includes("def helper():\n    return 42"));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "result" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      }));
    };

    const res = await proxyFetch("/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_prefix: "code",
        input_suffix: "end",
        input_extra: [{ filename: "helpers.py", text: "def helper():\n    return 42" }],
      }),
    });

    assert.equal(res.status, 200);
  });

  it("POST /infill with filename should include CURRENT_FILE in messages", async () => {
    mockHandler = async (req, res) => {
      const body = JSON.parse(await readBody(req));
      const userMsg = body.messages[1].content;
      assert.ok(userMsg.includes("<|file_separator|>main.py\n"));
      assert.ok(userMsg.includes("code"));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "result" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      }));
    };

    const res = await proxyFetch("/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_prefix: "code",
        input_suffix: "end",
        filename: "main.py",
      }),
    });

    assert.equal(res.status, 200);
  });

  it("POST /infill with both input_extra and filename should include both", async () => {
    mockHandler = async (req, res) => {
      const body = JSON.parse(await readBody(req));
      const userMsg = body.messages[1].content;
      assert.ok(userMsg.includes("<|file_separator|>lib.js\n"));
      assert.ok(userMsg.includes("<|file_separator|>app.js\n"));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "result" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      }));
    };

    const res = await proxyFetch("/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_prefix: "code",
        input_suffix: "end",
        input_extra: [{ filename: "lib.js", text: "export const x = 1;" }],
        filename: "app.js",
      }),
    });

    assert.equal(res.status, 200);
  });

  it("POST /infill with n_predict=0 should return empty response without hitting upstream", async () => {
    let upstreamCalled = false;
    mockHandler = (_req, _res) => {
      upstreamCalled = true;
    };

    const res = await proxyFetch("/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_prefix: "hello",
        input_suffix: "world",
        n_predict: 0,
      }),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.content, "");
    assert.equal(json.tokens_evaluated, 0);
    assert.equal(json.tokens_predicted, 0);
    assert.equal(upstreamCalled, false, "upstream should not be called for n_predict=0");
  });

  it("POST /infill with n_predict=1 should forward to upstream normally", async () => {
    mockHandler = async (req, res) => {
      const body = JSON.parse(await readBody(req));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "x" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }));
    };

    const res = await proxyFetch("/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_prefix: "test",
        input_suffix: "",
        n_predict: 1,
      }),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.content, "x");
    assert.equal(json.tokens_predicted, 1);
  });

  it("POST /infill with prompt should include prompt text in FIM prefix", async () => {
    mockHandler = async (req, res) => {
      const body = JSON.parse(await readBody(req));
      const userMsg = body.messages[1].content;
      // prompt should be concatenated after input_prefix in the FIM prefix
      assert.ok(userMsg.includes("header\npartial<|fim_suffix|>"));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "result" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      }));
    };

    const res = await proxyFetch("/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_prefix: "header\n",
        prompt: "partial",
        input_suffix: "\nrest",
      }),
    });

    assert.equal(res.status, 200);
  });

  it("POST /infill without prompt should behave unchanged", async () => {
    mockHandler = async (req, res) => {
      const body = JSON.parse(await readBody(req));
      const userMsg = body.messages[1].content;
      // Without prompt, prefix goes directly into FIM prefix
      assert.ok(userMsg.includes("header\n<|fim_suffix|>"));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "result" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      }));
    };

    const res = await proxyFetch("/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_prefix: "header\n",
        input_suffix: "\nrest",
      }),
    });

    assert.equal(res.status, 200);
  });

  it("POST /infill should strip repeated prefix context from response", async () => {
    mockHandler = async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "return x;\n  return x;" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }));
    };

    const res = await proxyFetch("/infill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_prefix: "function foo() {\n  return x;\n",
        input_suffix: "}",
      }),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    // The repeated "return x;\n" prefix tail should be stripped
    assert.equal(json.content, "  return x;");
  });
});
