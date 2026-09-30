import assert from "node:assert/strict";
import test from "node:test";
import {
  addRequestContext,
  nearestReview,
  rekeyHash,
  remapIds,
  upstreamBase,
  volatileIds,
} from "../aimock/request-context.mjs";

function request(result = "first result") {
  return {
    model: "test-model",
    messages: [
      { role: "system", content: "Use tools" },
      { role: "user", content: "Compare with the baseline" },
      {
        role: "assistant", content: "",
        tool_calls: [{ id: "call_reused", type: "function", function: {
          name: "run_code", arguments: '{"code":"inspect()"}',
        } }],
      },
      { role: "tool", tool_call_id: "call_reused", content: result },
    ],
    tools: [{ type: "function", function: { name: "run_code" } }],
    temperature: 0,
  };
}

test("different tool results at the same trimmed history length cannot replay each other", () => {
  const first = request();
  const second = request("new partner data");
  assert.equal(first.messages.length, second.messages.length);
  assert.notEqual(addRequestContext(first)._context, addRequestContext(second)._context);
});

test("identical input matches deterministically without modifying the upstream request", () => {
  const original = request();
  const before = structuredClone(original);
  const { _context, ...forwarded } = addRequestContext(original);
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(_context, addRequestContext(reordered)._context);
  assert.deepEqual(forwarded, before);
  assert.deepEqual(original, before);
  assert.match(_context, /^system-[a-f0-9]{8}--request-[a-f0-9]{64}$/);
});

test("tool definitions, system instructions and model options affect matching", () => {
  const baseline = request();
  for (const change of [
    (r) => { r.tools[0].function.description = "New service"; },
    (r) => { r.messages[0].content = "New instructions"; },
    (r) => { r.temperature = 1; },
    (r) => { r.model = "different-model"; },
  ]) {
    const changed = structuredClone(baseline);
    change(changed);
    assert.notEqual(addRequestContext(baseline)._context, addRequestContext(changed)._context);
  }
});

test("rekeying ignores artifact checksums and sizes, but nothing else", () => {
  const artifact = (sha, size, name = "forecast.json") =>
    request(JSON.stringify({ artifact: { filename: name, size_bytes: size, sha256: sha.repeat(64) } }));
  const recorded = artifact("a", 7186);
  assert.notEqual(addRequestContext(recorded)._context, addRequestContext(artifact("b", 7201))._context);
  assert.equal(rekeyHash(recorded), rekeyHash(artifact("b", 7201)));
  assert.notEqual(rekeyHash(recorded), rekeyHash(artifact("a", 7186, "other.json")));
});

test("requests without a system prompt are isolated and existing context is preserved", () => {
  const first = { messages: [{ role: "user", content: "first" }], _context: "demo" };
  const second = { messages: [{ role: "user", content: "second" }], _context: "demo" };
  assert.match(addRequestContext(first)._context, /^demo--system-/);
  assert.notEqual(addRequestContext(first)._context, addRequestContext(second)._context);
});

test("upstream base drops the /v1 suffix that AI Mock appends again", () => {
  assert.equal(upstreamBase("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/");
  assert.equal(upstreamBase("https://api.openai.com/v1"), "https://api.openai.com/");
  assert.equal(upstreamBase("http://ollama:11434/v1"), "http://ollama:11434/");
  assert.throws(() => upstreamBase("https://example.com/openai"), /must end in \/v1/);
});

test("volatile IDs are matched by position, not value", () => {
  const withCandidate = (id) => {
    const r = request(JSON.stringify({ candidate_id: id }));
    return r;
  };
  const recorded = withCandidate("XD0nUUbbKEEmSOLh7EQdggDRRCKXM3lE");
  const current = withCandidate("MYew3-sadaCZe7SxVGpSUJy-t8J5iDOx");
  assert.equal(addRequestContext(recorded)._context, addRequestContext(current)._context);
  const response = { toolCalls: [{ name: "onboard_candidate",
    arguments: '{"candidate_id":"XD0nUUbbKEEmSOLh7EQdggDRRCKXM3lE"}' }] };
  assert.deepEqual(
    remapIds(response, volatileIds(recorded), volatileIds(current)),
    { toolCalls: [{ name: "onboard_candidate",
      arguments: '{"candidate_id":"MYew3-sadaCZe7SxVGpSUJy-t8J5iDOx"}' }] },
  );
});

test("clock readings do not affect matching, other tool results do", () => {
  const atTime = (time, name = "get_current_time") => ({
    messages: [
      { role: "user", content: "Analyse May 2026" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_clock", type: "function",
        function: { name, arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_clock", content: `ISO: ${time}` },
    ],
  });
  assert.equal(
    addRequestContext(atTime("2026-09-28T07:17:59Z"))._context,
    addRequestContext(atTime("2026-09-29T10:00:00Z"))._context,
  );
  assert.notEqual(
    addRequestContext(atTime("2026-09-28T07:17:59Z", "run_code"))._context,
    addRequestContext(atTime("2026-09-29T10:00:00Z", "run_code"))._context,
  );
});

test("search scores do not affect matching, the ranked items do", () => {
  const search = (items) => request(JSON.stringify({ items }));
  assert.equal(
    addRequestContext(search([{ id: "dwd", score: 0.4961 }]))._context,
    addRequestContext(search([{ id: "dwd", score: 0.4962 }]))._context,
  );
  assert.notEqual(
    addRequestContext(search([{ id: "dwd", score: 0.5 }]))._context,
    addRequestContext(search([{ id: "smard", score: 0.5 }]))._context,
  );
});

test("saved artifacts match by position and ignore their save time", () => {
  const saved = (id, at) => request(
    `artifact {'id': '${id}', 'modified_at': '${at}'} ` +
    JSON.stringify({ id, expires_at: at }),
  );
  const recorded = saved("file-6c9275b880a240b88e03e5a8222df841", "2026-09-28T09:16:12.451505+00:00");
  const current = saved("file-0b0ae3f9313147b195118d356aa260ec", "2026-09-28T10:15:38.666336+00:00");
  assert.equal(addRequestContext(recorded)._context, addRequestContext(current)._context);
  assert.deepEqual(
    remapIds({ data: { result: "file-6c9275b880a240b88e03e5a8222df841" } },
      volatileIds(recorded), volatileIds(current)),
    { data: { result: "file-0b0ae3f9313147b195118d356aa260ec" } },
  );
});

test("panel review screenshots and call metrics do not affect matching", () => {
  const review = (pixels, latency) => ({
    messages: [
      { role: "system", content: "Review the panel" },
      { role: "user", content: [
        { type: "text", text: "Does anything overlap?" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${pixels}` } },
      ] },
      { role: "tool", tool_call_id: "call_review", content: JSON.stringify({ latency_ms: latency }) },
    ],
  });
  const recorded = review("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", 8162);
  const current = review("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", 7537);
  assert.equal(addRequestContext(recorded)._context, addRequestContext(current)._context);
  assert.deepEqual(volatileIds(recorded), []);
  const usage = (extra) => request(JSON.stringify({ usage: { total_tokens: 2619, ...extra }, latency_ms: 8162 }));
  assert.equal(
    addRequestContext(usage({ provider_reported_cost: 0.0014 }))._context,
    addRequestContext(usage({}))._context,
  );
});

test("a panel review replays the recording with the closest screenshot sizes", () => {
  const review = (normal, narrow) => ({
    messages: [
      { role: "system", content: "Review the panel" },
      { role: "user", content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(normal)}` } },
        { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(narrow)}` } },
      ] },
    ],
  });
  const recorded = [review(110886, 64170), review(125098, 84222), review(220706, 91758)]
    .map((r) => addRequestContext(r)._context);
  assert.equal(new Set(recorded).size, 3);
  assert.equal(nearestReview(addRequestContext(review(125102, 84219))._context, recorded), recorded[1]);
  assert.equal(nearestReview(addRequestContext(request())._context, recorded), undefined);
});
