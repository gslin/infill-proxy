import { createServer } from "node:http";

/**
 * Set environment variables and dynamically import the proxy module.
 * Unit tests call with no args; integration tests pass { OPENAI_ENDPOINT }.
 */
export async function importModule(envOverrides = {}) {
  const defaults = {
    OPENAI_ENDPOINT: "http://127.0.0.1:0/v1",
    LLAMA_INFILL_ENDPOINT: "http://127.0.0.1:0/infill",
    MODEL: "test-model",
    API_KEY: "test-key",
    API_MODE: "chat",
    DEFAULT_STOP_SEQUENCES: '["\\n\\n"]',
    TRIM_RESPONSE: "true",
  };
  Object.assign(process.env, defaults, envOverrides);
  return await import("../../index.mjs");
}

/**
 * Read the full request body as a string.
 */
export function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

/**
 * Start a mock HTTP server whose request handler can be swapped via handlerRef.
 * Returns { server, port }.
 */
export async function startMockServer(handlerRef) {
  const server = createServer(async (req, res) => {
    if (handlerRef.current) {
      handlerRef.current(req, res);
    } else {
      res.writeHead(500);
      res.end("no handler");
    }
  });

  const port = await new Promise((resolve) => {
    server.listen(0, () => {
      resolve(server.address().port);
    });
  });

  return { server, port };
}
