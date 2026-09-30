import { createHash } from "node:crypto";

/** JSON with object keys sorted, so equal requests serialize identically. */
export function stableJson(value, space) {
  return JSON.stringify(
    value,
    (_key, item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      return Object.fromEntries(
        Object.keys(item).sort().map((key) => [key, item[key]]),
      );
    },
    space,
  );
}

// WoTBot hands the model fresh random IDs on every run (discovery candidates,
// artifacts, panels, jobs): artifact IDs, UUIDs and URL-safe tokens of 32 or
// 43 characters. Stable IDs of the same shape are harmless; they map to the
// same placeholder.
const VOLATILE_ID =
  /(?<![\w-])(?:file-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[\w-]{43}|[\w-]{32})(?![\w-])/g;

// Record timestamps set by WoTBot when it saves something, in tool results as
// JSON or as printed Python dicts.
const RECORD_TIME =
  /((?:\\"|')(?:created_at|modified_at|updated_at|expires_at)(?:\\"|'):\s*(?:\\"|'))[^"'\\]*/g;

// The clock differs between recording and replay. Prompts name absolute dates,
// so the reading only has to be ignored, not replayed.
const CLOCK_TOOLS = new Set(["get_current_time"]);

// Search results rank by live embeddings, whose similarity scores drift in the
// fourth decimal between runs. Matching ignores the value, not the ranking.
const SEARCH_SCORE = /(\\"score\\":\s*)-?\d+(?:\.\d+)?(?:e-?\d+)?/g;

// Timing and cost of a previous model call, reported inside panel review
// results. Only the upstream reports a cost, so replays lack the field.
const CALL_METRIC = /(\\"latency_ms\\":\s*)-?\d+(?:\.\d+)?(?:e-?\d+)?/g;
const CALL_COST = /,\s*\\"provider_reported_cost\\":\s*-?\d+(?:\.\d+)?(?:e-?\d+)?/g;

// Panel review screenshots can differ by a few pixels between runs of the
// same panel. Blanked before the ID scan too, so base64 never yields IDs.
const INLINE_IMAGE = /data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g;

// Checksums and sizes of saved artifacts. A rewritten fixture's expected
// request cannot know them when the rewrite changed the artifact's content.
const ARTIFACT_SHA256 = /(\\*"sha256\\*":\s*\\*")[0-9a-f]{64}/g;
const ARTIFACT_SIZE = /(\\*"size_bytes\\*":\s*)\d+/g;

// WoTBot changed this panel-tool instruction after earlier recordings.
// It describes the same retry contract; keep the recorded wording in the
// matching key without changing the request forwarded to the model.
const PANEL_REPAIR_RECORDED = [
  "Each panel gets an initial attempt and at most TWO repair attempts in this",
  "    user turn, across static, data and browser failures. Create panels one at a",
  "    time. Respect retry_allowed in the result: false means stop and explain the",
].join("\n");
const PANEL_REPAIR_CURRENT = [
  "Each panel gets an initial attempt and a limited number of repair attempts",
  "    (max_repairs in the result) in this user turn, across static, data and",
  "    browser failures. Create panels one at a time. Respect retry_allowed in the result: false means stop and explain the",
].join("\n");

function normalizeToolDescriptions(input) {
  if (!Array.isArray(input.tools)) return input;
  let changed = false;
  const tools = input.tools.map((tool) => {
    const description = tool.function?.description;
    if (tool.function?.name !== "create_web_interface" ||
        typeof description !== "string" || !description.includes(PANEL_REPAIR_CURRENT)) return tool;
    changed = true;
    return {
      ...tool,
      function: { ...tool.function,
        description: description.replace(PANEL_REPAIR_CURRENT, PANEL_REPAIR_RECORDED) },
    };
  });
  return changed ? { ...input, tools } : input;
}

/** The request as matched: no context tag, images, clock readings. */
function modelInput(request) {
  return requestJson(request).replace(INLINE_IMAGE, "<image>");
}

function requestJson(request) {
  const { _context, ...rawInput } = request;
  const input = normalizeToolDescriptions(rawInput);
  const clockCalls = new Set(
    (input.messages ?? []).flatMap((message) =>
      (message.tool_calls ?? [])
        .filter((call) => CLOCK_TOOLS.has(call.function?.name))
        .map((call) => call.id),
    ),
  );
  if (clockCalls.size === 0) return stableJson(input);
  const messages = input.messages.map((message) =>
    message.role === "tool" && clockCalls.has(message.tool_call_id)
      ? { ...message, content: "<current time>" }
      : message,
  );
  return stableJson({ ...input, messages });
}

/** The request's volatile IDs, in order of first appearance. */
export function volatileIds(request) {
  return [...new Set(modelInput(request).match(VOLATILE_ID) ?? [])];
}

/** The text a request is matched by; diff two of these to explain a miss. */
export function canonicalInput(request) {
  const ids = volatileIds(request);
  return modelInput(request)
    .replace(VOLATILE_ID, (id) => `<id-${ids.indexOf(id)}>`)
    .replace(SEARCH_SCORE, "$1<score>")
    .replace(RECORD_TIME, "$1<time>")
    .replace(CALL_METRIC, "$1<metric>")
    .replace(CALL_COST, "");
}

/**
 * A request's key when re-keying rewritten fixtures: its canonical input
 * without artifact checksums and sizes (see aimock/rewrite-aimock-fixtures.mjs).
 */
export function rekeyHash(request) {
  const input = canonicalInput(request)
    .replace(ARTIFACT_SHA256, "$1<sha256>")
    .replace(ARTIFACT_SIZE, "$1<size>");
  return createHash("sha256").update(input).digest("hex");
}

/** Match the actual model input, even when the agent trims its history. */
export function addRequestContext(request) {
  const systemPrompt = (request.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : stableJson(message.content),
    )
    .join("\n");
  const systemHash = createHash("sha256")
    .update(systemPrompt)
    .digest("hex")
    .slice(0, 8);
  // A turn count stops identifying a step once the rolling context is full.
  // Include tool results, schemas and model options so that a different input
  // cannot replay a previous response (and its original tool-call IDs).
  // Volatile IDs become ordinal placeholders, so a rerun of the same flow
  // matches its recording.
  const requestHash = createHash("sha256").update(canonicalInput(request)).digest("hex");
  // Panel reviews differ only in their screenshots, which may shift by a few
  // bytes between runs; their sizes tell the panels apart (see nearestReview).
  const sizes = imageSizes(request);
  const context = sizes.length
    ? `system-${systemHash}--review-${requestHash.slice(0, 16)}-${sizes.join("-")}`
    : `system-${systemHash}--request-${requestHash}`;
  const { _context } = request;
  return {
    ...request,
    _context: _context ? `${_context}--${context}` : context,
  };
}

/** Base64 lengths of the request's inline images, in order. */
export function imageSizes(request) {
  return (requestJson(request).match(INLINE_IMAGE) ?? []).map((url) => url.length);
}

/**
 * The recorded panel review closest to a review context without an exact
 * recording: same system prompt and text, smallest total difference in
 * screenshot sizes. Returns undefined for other contexts or no candidate.
 */
export function nearestReview(context, recordedContexts) {
  const parse = (value) => {
    const found = /^(.*--review-[0-9a-f]{16})-([\d-]+)$/.exec(value);
    return found && { prefix: found[1], sizes: found[2].split("-").map(Number) };
  };
  const wanted = parse(context);
  if (!wanted) return undefined;
  let best;
  for (const candidate of recordedContexts) {
    const recorded = parse(candidate);
    if (recorded?.prefix !== wanted.prefix || recorded.sizes.length !== wanted.sizes.length) continue;
    const distance = recorded.sizes.reduce((sum, size, i) => sum + Math.abs(size - wanted.sizes[i]), 0);
    if (!best || distance < best.distance) best = { context: candidate, distance };
  }
  return best?.context;
}

/**
 * A recorded response with the recording's volatile IDs swapped for the ones
 * of the current request, matched by position.
 */
export function remapIds(response, recordedIds, currentIds) {
  let json = JSON.stringify(response);
  const pairs = recordedIds
    .map((id, index) => [id, currentIds[index]])
    .filter(([from, to]) => to !== undefined && from !== to)
    .sort(([a], [b]) => b.length - a.length);
  // Via unique tokens, so a swap never feeds into the next one.
  pairs.forEach(([from], index) => {
    json = json.split(from).join(`\u0000${index}\u0000`);
  });
  pairs.forEach(([, to], index) => {
    json = json.split(`\u0000${index}\u0000`).join(to);
  });
  return JSON.parse(json);
}

/**
 * The upstream origin for AI Mock's OpenAI route, from an OpenAI base URL.
 *
 * WoTBot calls AI Mock at `/v1/chat/completions`, and AI Mock appends that
 * path to the upstream, so the configured `…/v1` suffix has to go:
 * `https://openrouter.ai/api/v1` becomes `https://openrouter.ai/api/`.
 */
export function upstreamBase(baseUrl) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/v1")) {
    throw new Error(
      `OpenAI base URL must end in /v1 to be proxied by AI Mock: ${baseUrl}`,
    );
  }
  url.pathname = `${path.slice(0, -"/v1".length)}/`;
  return url.toString();
}
