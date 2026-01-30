import "dotenv/config";
import { createServer } from "node:http";

const llamaEndpoint = new URL(process.env.LLAMA_INFILL_ENDPOINT || "http://0.0.0.0:8012/infill");
const HOST = llamaEndpoint.hostname;
const PORT = parseInt(llamaEndpoint.port, 10);
const INFILL_PATH = llamaEndpoint.pathname;

const openaiEndpoint = new URL(process.env.OPENAI_ENDPOINT || "https://api.openai.com/v1");
const openaiBase = openaiEndpoint.href.replace(/\/$/, "");
const OPENAI_COMPLETIONS_URL = `${openaiBase}/completions`;
const OPENAI_CHAT_URL = process.env.OPENAI_CHAT_URL || `${openaiBase}/chat/completions`;

const API_KEY = process.env.API_KEY || "";
const MODEL = process.env.MODEL || "unknown";
const API_MODE = process.env.API_MODE || "chat"; // "chat" or "completions"
const TRIM_RESPONSE = (process.env.TRIM_RESPONSE || "true") === "true";

const DEFAULT_FREQUENCY_PENALTY = process.env.DEFAULT_FREQUENCY_PENALTY != null
  ? parseFloat(process.env.DEFAULT_FREQUENCY_PENALTY) : null;
const DEFAULT_PRESENCE_PENALTY = process.env.DEFAULT_PRESENCE_PENALTY != null
  ? parseFloat(process.env.DEFAULT_PRESENCE_PENALTY) : null;

const STRIP_CODE_FENCES = (process.env.STRIP_CODE_FENCES || "true") === "true";
const STRIP_REPEATED_CONTEXT = (process.env.STRIP_REPEATED_CONTEXT || "true") === "true";
const CONTEXT_OVERLAP_WINDOW = parseInt(process.env.CONTEXT_OVERLAP_WINDOW || "200", 10);

let DEFAULT_STOP_SEQUENCES = [];
try {
  const raw = process.env.DEFAULT_STOP_SEQUENCES;
  if (raw) DEFAULT_STOP_SEQUENCES = JSON.parse(raw);
} catch {
  // ignore invalid JSON, keep empty array
}

let currentInfillController = null;

/**
 * Build the FIM content string shared by both prompt and chat modes.
 */
function buildFIMContent(inputPrefix, inputSuffix, inputExtra = [], filename = "") {
  let content = "<|fim_prefix|>";
  for (const entry of inputExtra) {
    content += `<|file_separator|>${entry.filename}\n${entry.text}\n`;
  }
  if (filename) {
    content += `<|file_separator|>${filename}\n`;
  }
  content += `${inputPrefix}<|fim_suffix|>${inputSuffix}<|fim_middle|>`;
  return content;
}

/**
 * Build a FIM prompt from prefix and suffix (completions mode).
 */
function buildFIMPrompt(inputPrefix, inputSuffix, inputExtra = [], filename = "") {
  return "Fill in the missing code at the cursor position.\n\n"
    + buildFIMContent(inputPrefix, inputSuffix, inputExtra, filename);
}

/**
 * Build chat messages array for FIM (chat mode).
 */
function buildFIMMessages(inputPrefix, inputSuffix, inputExtra = [], filename = "") {
  const system = process.env.SYSTEM_PROMPT || [
    "You are a code completion engine performing Fill-in-the-Middle (FIM).",
    "",
    "The user message contains code using FIM tokens:",
    "- <|fim_prefix|>: Marks the start of the prefix region (all code/context before the cursor).",
    "- <|fim_suffix|>: Marks the start of the suffix region (code after the cursor).",
    "- <|fim_middle|>: Marks the insertion point — output your completion here.",
    "- <|file_separator|>: Separates file segments within the prefix. Each segment starts with <|file_separator|> followed by the filename, then the file content on subsequent lines. The last segment is the file being edited; its content is the code leading up to the cursor.",
    "",
    "Your task: Output ONLY the code to insert at the <|fim_middle|> position.",
    "",
    "Rules:",
    "- Output raw code only — no explanations, no markdown, no code fences.",
    "- Do not repeat any part of the prefix or suffix.",
    "- Seamlessly continue from where the prefix ends and lead into where the suffix begins.",
    "- If nothing should be inserted, output nothing.",
    "- If the suffix is empty, complete only the current logical block, then stop.",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: buildFIMContent(inputPrefix, inputSuffix, inputExtra, filename) },
  ];
}

/**
 * Merge default and client-provided stop sequences (max 4 for OpenAI API).
 */
function mergeStopSequences(clientStop) {
  const merged = [...DEFAULT_STOP_SEQUENCES];
  if (Array.isArray(clientStop)) {
    for (const s of clientStop) {
      if (!merged.includes(s)) merged.push(s);
    }
  } else if (typeof clientStop === "string" && clientStop) {
    if (!merged.includes(clientStop)) merged.push(clientStop);
  }
  return merged.slice(0, 4);
}

/**
 * Strip markdown code fences wrapping the entire output.
 */
function stripCodeFences(text) {
  const match = text.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
  if (match) return match[1];
  return text;
}

/**
 * Strip repeated prefix/suffix context from the completion output.
 * Checks if the content starts with the tail of the prefix or
 * ends with the head of the suffix, and removes the overlap.
 */
function stripRepeatedContext(content, prefix, suffix) {
  if (!content) return content;

  // Strip prefix overlap at the start of content
  if (prefix) {
    const window = Math.min(prefix.length, CONTEXT_OVERLAP_WINDOW);
    const prefixTail = prefix.slice(-window);
    // Find the longest overlap: prefixTail's suffix that matches content's prefix
    for (let len = Math.min(prefixTail.length, content.length); len > 0; len--) {
      const candidate = prefixTail.slice(-len);
      if (candidate.trim() && content.startsWith(candidate)) {
        content = content.slice(len);
        break;
      }
    }
  }

  // Strip suffix overlap at the end of content
  if (suffix) {
    const window = Math.min(suffix.length, CONTEXT_OVERLAP_WINDOW);
    const suffixHead = suffix.slice(0, window);
    // Find the longest overlap: suffixHead's prefix that matches content's suffix
    for (let len = Math.min(suffixHead.length, content.length); len > 0; len--) {
      const candidate = suffixHead.slice(0, len);
      if (candidate.trim() && content.endsWith(candidate)) {
        content = content.slice(0, -len);
        break;
      }
    }
  }

  return content;
}

/**
 * Send a JSON response with the given status code and payload.
 */
function sendJSON(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * Read the full request body as a string.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/**
 * Process a single SSE line from the upstream response.
 */
function processSSELine(line, useChat, res) {
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") {
    res.write("data: [DONE]\n\n");
    return;
  }
  let chunk;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return;
  }
  const content = useChat
    ? (chunk.choices?.[0]?.delta?.content || "")
    : (chunk.choices?.[0]?.text || "");
  const stop = chunk.choices?.[0]?.finish_reason === "stop";
  res.write(`data: ${JSON.stringify({ content, stop })}\n\n`);
}

/**
 * Handle a streaming response from the upstream API.
 */
async function handleStreamResponse(resp, useChat, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line) console.log("<-- upstream chunk:", line);
        processSSELine(line, useChat, res);
      }
    }
  } catch (err) {
    console.error("Stream processing error:", err);
  }

  // Process remaining buffer data
  if (buffer.trim()) {
    processSSELine(buffer.trim(), useChat, res);
  }

  if (!res.writableEnded) {
    res.end();
  }
}

/**
 * GET /v1/models — return configured MODEL directly.
 */
function handleModels(_req, res) {
  sendJSON(res, 200, {
    object: "list",
    data: [{ id: MODEL, object: "model", owned_by: "openai" }],
  });
}

/**
 * POST /infill — accept llama.cpp infill format, proxy to OpenAI API.
 */
async function handleInfill(req, res, rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    sendJSON(res, 400, { error: { message: "Invalid JSON" } });
    return;
  }

  // Cancel any previous in-flight upstream request
  if (currentInfillController) {
    currentInfillController.abort();
  }
  const controller = new AbortController();
  currentInfillController = controller;

  // Cancel upstream request if client disconnects
  req.on("close", () => {
    controller.abort();
  });

  // Intercept cache-warming requests (n_predict=0) from llama.vim.
  // OpenAI API has no cache-warming concept; return empty response immediately.
  if (body.n_predict === 0) {
    sendJSON(res, 200, {
      content: "",
      tokens_evaluated: 0,
      tokens_predicted: 0,
    });
    return;
  }

  const inputPrefix = (body.input_prefix || "") + (body.prompt || "");
  const inputSuffix = body.input_suffix || "";
  const inputExtra = Array.isArray(body.input_extra) ? body.input_extra : [];
  const filename = body.filename || "";
  const stream = body.stream || false;
  const useChat = API_MODE === "chat";

  // Build the OpenAI request body
  const openaiBody = { model: MODEL };

  if (useChat) {
    openaiBody.messages = buildFIMMessages(inputPrefix, inputSuffix, inputExtra, filename);
  } else {
    openaiBody.prompt = buildFIMPrompt(inputPrefix, inputSuffix, inputExtra, filename);
  }

  openaiBody.temperature = 1;

  if (body.frequency_penalty != null) {
    openaiBody.frequency_penalty = body.frequency_penalty;
  } else if (DEFAULT_FREQUENCY_PENALTY != null) {
    openaiBody.frequency_penalty = DEFAULT_FREQUENCY_PENALTY;
  }

  if (body.presence_penalty != null) {
    openaiBody.presence_penalty = body.presence_penalty;
  } else if (DEFAULT_PRESENCE_PENALTY != null) {
    openaiBody.presence_penalty = DEFAULT_PRESENCE_PENALTY;
  }

  // Merge stop sequences
  const stop = mergeStopSequences(body.stop);
  if (stop.length > 0) openaiBody.stop = stop;

  if (stream) openaiBody.stream = true;

  const upstreamUrl = useChat ? OPENAI_CHAT_URL : OPENAI_COMPLETIONS_URL;
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  try {
    console.log("--> upstream:", JSON.stringify(openaiBody));
    const resp = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(openaiBody),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      sendJSON(res, 502, { error: { message: errText } });
      return;
    }

    if (stream) {
      await handleStreamResponse(resp, useChat, res);
    } else {
      const data = await resp.json();
      console.log("<-- upstream:", JSON.stringify(data));

      // Chat mode: message.content; Completions mode: text
      let content = useChat
        ? (data.choices?.[0]?.message?.content || "")
        : (data.choices?.[0]?.text || "");

      if (STRIP_CODE_FENCES) {
        content = stripCodeFences(content);
      }
      if (STRIP_REPEATED_CONTEXT) {
        content = stripRepeatedContext(content, inputPrefix, inputSuffix);
      }
      if (TRIM_RESPONSE) {
        content = content.trimEnd();
      }

      const usage = data.usage || {};

      sendJSON(res, 200, {
        content,
        tokens_evaluated: usage.prompt_tokens || 0,
        tokens_predicted: usage.completion_tokens || 0,
      });
    }
  } catch (err) {
    if (err.name === "AbortError") {
      // Superseded by a newer request — return empty response
      if (!res.headersSent) {
        sendJSON(res, 200, {
          content: "",
          tokens_evaluated: 0,
          tokens_predicted: 0,
        });
      }
      return;
    }
    sendJSON(res, 502, { error: { message: `Failed to reach upstream: ${err.message}` } });
  } finally {
    if (currentInfillController === controller) {
      currentInfillController = null;
    }
  }
}

const server = createServer(async (req, res) => {
  const start = Date.now();

  // Read request body for POST
  let reqBody = "";
  if (req.method === "POST") {
    reqBody = await readBody(req);
  }
  console.log(`--> ${req.method} ${req.url}`);
  if (reqBody) {
    console.log(`--> body: ${reqBody}`);
  }

  // Intercept response body
  const resChunks = [];
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);

  res.write = (chunk, ...args) => {
    if (chunk) resChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return origWrite(chunk, ...args);
  };
  res.end = (chunk, ...args) => {
    if (chunk) resChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return origEnd(chunk, ...args);
  };

  res.on("finish", () => {
    const ms = Date.now() - start;
    const resBody = resChunks.join("");
    console.log(`<-- ${req.method} ${req.url} ${res.statusCode} ${ms}ms`);
    if (resBody) {
      console.log(`<-- body: ${resBody}`);
    }
  });

  if (req.method === "GET" && req.url === "/v1/models") {
    return handleModels(req, res);
  }
  if (req.method === "POST" && req.url === INFILL_PATH) {
    return handleInfill(req, res, reqBody);
  }

  sendJSON(res, 404, { error: { message: "Not found" } });
});

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const upstreamUrl = API_MODE === "chat" ? OPENAI_CHAT_URL : OPENAI_COMPLETIONS_URL;
  server.listen(PORT, HOST, () => {
    console.log(`Infill proxy listening on ${llamaEndpoint.href}, forwarding to ${upstreamUrl} (mode=${API_MODE})`);
  });
}

export { buildFIMContent, buildFIMPrompt, buildFIMMessages, mergeStopSequences, stripCodeFences, stripRepeatedContext, server };
