// AI Mock launcher for WoTBot's model traffic.
//   proxy   forward to the configured upstream, save nothing (default)
//   record  replay matches; forward and save misses as fixtures
//   hybrid  replay matches; forward misses without saving them
//   replay  answer only from fixtures; fail when a request has no match
//   rekey   replay, and move each rewritten fixture to the key of the live
//           request it answers (see aimock/rewrite-aimock-fixtures.mjs)
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { LLMock } from "/app/dist/index.js";
import {
  addRequestContext,
  nearestReview,
  rekeyHash,
  remapIds,
  stableJson,
  upstreamBase,
  volatileIds,
} from "./request-context.mjs";

const fixtureDirectory = "/fixtures";
const recordedFixtureDirectory = `${fixtureDirectory}/recorded`;
// Per fixture context, the volatile IDs its recording saw (see remapIds).
const idDirectory = `${fixtureDirectory}/ids`;

// Older demo checkouts use "live" for forwarding without fixtures.
const configuredMode = process.env.AIMOCK_MODE || "proxy";
const mode = configuredMode === "live" ? "proxy" : configuredMode;
if (!["proxy", "record", "hybrid", "replay", "rekey"].includes(mode)) {
  throw new Error(`AIMOCK_MODE must be proxy, record, hybrid, replay or rekey, not "${configuredMode}"`);
}
const provider = process.env.AIMOCK_PROVIDER || "openai";
if (!["openai", "openrouter"].includes(provider)) {
  throw new Error(`Unsupported AIMOCK_PROVIDER: ${provider}`);
}
// AIMOCK_UPSTREAM_URL is the provider origin. The older OpenAI base-URL
// setting includes /v1, which AI Mock adds to the forwarded request itself.
const upstream = process.env.AIMOCK_UPSTREAM_URL ||
  (process.env.AIMOCK_UPSTREAM_BASE_URL
    ? upstreamBase(process.env.AIMOCK_UPSTREAM_BASE_URL)
    : provider === "openrouter" ? "https://openrouter.ai" : "https://api.openai.com");
const strictReplay = mode === "replay" || mode === "rekey";
const replaying = strictReplay || mode === "hybrid";

// Readable copies of what the model is asked, named like the fixture context,
// to diff a replay miss against its recording. Upstream requests go to
// /requests; requests matching loaded fixtures go to /requests/replay.
const dumpRequests = process.env.AIMOCK_DUMP_REQUESTS === "true";
if (mode === "record") mkdirSync(idDirectory, { recursive: true });

// Contexts of the loaded recordings, for replaying panel reviews whose
// screenshots came out a few bytes different.
let recordedContexts = new Set();

// Rekey: the expected requests of rewritten fixtures, by rekeyHash, and the
// fixtures moved so far, by the live context they answer.
const rekeyDirectory = "/requests/rekey";
const expectedRequests = new Map();
const rekeyed = new Map();
if (mode === "rekey") {
  for (const name of readdirSync(rekeyDirectory).filter((file) => file.endsWith(".json"))) {
    const expected = JSON.parse(readFileSync(`${rekeyDirectory}/${name}`, "utf8"));
    expectedRequests.set(rekeyHash(expected), name.slice(0, -".json".length));
  }
}

/** Move a fixture and its ID list from one context to another on disk. */
function moveFixture(from, to) {
  const directory = `${recordedFixtureDirectory}/${from}`;
  for (const name of readdirSync(directory)) {
    const file = `${directory}/${name}`;
    const document = JSON.parse(readFileSync(file, "utf8"));
    for (const fixture of document.fixtures) {
      if (fixture.match?.context === from) fixture.match.context = to;
    }
    writeFileSync(file, JSON.stringify(document, null, 2));
  }
  renameSync(directory, `${recordedFixtureDirectory}/${to}`);
  renameSync(`${idDirectory}/${from}.json`, `${idDirectory}/${to}.json`);
}

function requestTransform(request) {
  const withContext = addRequestContext(request);
  if (replaying && !recordedContexts.has(withContext._context)) {
    const nearest = nearestReview(withContext._context, recordedContexts);
    if (nearest) {
      console.log(`[wotbot-aimock] review ${withContext._context} -> ${nearest}`);
      withContext._context = nearest;
    }
  }
  // Embeddings match by their input, not by context.
  if (mode === "rekey" && request.messages && !recordedContexts.has(withContext._context)) {
    const live = withContext._context;
    const { _context, ...input } = withContext;
    const expected = rekeyed.get(live) ?? expectedRequests.get(rekeyHash(input));
    if (expected) {
      if (!rekeyed.has(live)) {
        moveFixture(expected, live);
        rekeyed.set(live, expected);
        console.log(`[wotbot-aimock] rekeyed ${expected} -> ${live}`);
      }
      // The loaded fixture keeps its old context until the next start.
      withContext._context = expected;
    } else {
      mkdirSync(`${rekeyDirectory}/miss`, { recursive: true });
      writeFileSync(`${rekeyDirectory}/miss/${live}.json`, stableJson(input, 2));
      console.log(`[wotbot-aimock] rekey miss ${live}`);
    }
  }
  const { _context, ...input } = withContext;
  // Requests answered from a recording must not overwrite that recording's
  // ID list or dump, or the next replay remaps against the wrong run.
  const miss = !recordedContexts.has(_context);
  const fresh = mode === "record" && miss;
  if (dumpRequests) {
    const directory = mode === "proxy" || ((mode === "record" || mode === "hybrid") && miss)
      ? "/requests" : "/requests/replay";
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/${_context}.json`, stableJson(input, 2));
  }
  if (fresh) {
    writeFileSync(`${idDirectory}/${_context}.json`, JSON.stringify(volatileIds(input)));
  }
  return withContext;
}

/** Answer recorded fixtures with the current run's IDs instead of the recording's. */
function remapRecordedIds(fixture) {
  const idFile = `${idDirectory}/${fixture.match?.context}.json`;
  if (!existsSync(idFile)) return;
  const recordedIds = JSON.parse(readFileSync(idFile, "utf8"));
  const response = fixture.response;
  fixture.response = (request) =>
    remapIds(response, recordedIds, volatileIds(request));
}

// Replays stream at the recorded pace; a factor above 1 divides every delay.
const replaySpeed = Number(process.env.AIMOCK_REPLAY_SPEED || 1);
if (!(replaySpeed > 0)) throw new Error("AIMOCK_REPLAY_SPEED must be a positive number");

const mock = new LLMock({
  host: "0.0.0.0",
  port: 4010,
  replaySpeed,
  logLevel: replaying ? "debug" : "info",
  strict: strictReplay,
  requestTransform,
  ...(strictReplay
    ? {}
    : {
        record: {
          providers: { [provider]: upstream },
          // Replaces WoTBot's `sk-aimock-…` placeholder, so the real key
          // never has to reach the agent services.
          providerKeys: { [provider]: process.env.AIMOCK_UPSTREAM_API_KEY },
          proxyOnly: mode === "proxy" || mode === "hybrid",
          fixturePath: recordedFixtureDirectory,
          upstreamTimeoutMs: 180_000,
          bodyTimeoutMs: 180_000,
        },
      }),
});

// Proxy mode must not answer from old recordings.
if (mode !== "proxy" && existsSync(recordedFixtureDirectory)) {
  mock.loadFixtureDir(recordedFixtureDirectory);
  mock.getFixtures().forEach(remapRecordedIds);
  recordedContexts = new Set(mock.getFixtures().map((fixture) => fixture.match?.context));
}
await mock.start();
console.log(`[wotbot-aimock] mode=${mode} provider=${provider}${replaying ? ` speed=${replaySpeed}x` : ""}`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await mock.stop();
}

process.once("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.once("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
