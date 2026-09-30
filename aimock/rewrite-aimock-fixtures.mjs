#!/usr/bin/env node
// Rewrite recorded AI Mock fixtures with text replacements instead of
// recording again, e.g. after renaming something in the prompts and sources.
//
// From a demo repository root:
//   node ../wotbot-demo-kit/aimock/rewrite-aimock-fixtures.mjs aimock/rewrites/<name>.json
//
// A fixture is keyed by a hash of its whole request, which the recording does
// not contain. The request dumps (AIMOCK_DUMP_REQUESTS=true) do: every fixture
// whose request or response contains a replaced text is rewritten, keyed by
// the hash of its rewritten request, and that request is saved to
// fixtures/aimock-requests/rekey. Replacements apply to every string of the
// request, the recorded answer and its match, so the rewritten answers produce
// the rewritten tool results in the next turns.
//
// Artifact checksums and sizes in tool results cannot be rewritten. Run the
// demo once with AIMOCK_MODE=rekey: fixtures whose live request differs from
// the expected one only in those move to the live key (see
// aimock/wotbot-aimock.mjs). Then replay once to check.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  addRequestContext,
  stableJson,
  volatileIds,
} from "../aimock/request-context.mjs";

const root = process.cwd();
const recordedDirectory = join(root, "fixtures/aimock/recorded");
const idDirectory = join(root, "fixtures/aimock/ids");
const requestDirectory = join(root, "fixtures/aimock-requests");
const rekeyDirectory = join(requestDirectory, "rekey");

const rulesFile = process.argv[2];
if (!rulesFile) {
  console.error("usage: node ../wotbot-demo-kit/aimock/rewrite-aimock-fixtures.mjs <rules.json> (from demo root)");
  process.exit(2);
}
const { replace, forbid } = JSON.parse(readFileSync(rulesFile, "utf8"));
// Tool results nest JSON in strings, escaped once or twice and sometimes as
// ASCII. Printable ASCII without quotes or backslashes reads the same at
// every level.
for (const [from, to] of replace) {
  assert.match(from + to, /^[ !#-[\]-~]*$/, `rule ${from} -> ${to}: printable ASCII only`);
}
const forbidden = forbid && new RegExp(forbid, "i");

function rewriteText(text) {
  return replace.reduce((result, [from, to]) => result.split(from).join(to), text);
}

function rewrite(value) {
  if (typeof value === "string") return rewriteText(value);
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
  }
  return value;
}

/** The request dump of a recording: saved while recording or replaying it. */
function dumpOf(context) {
  return [join(requestDirectory, `${context}.json`), join(requestDirectory, "replay", `${context}.json`)]
    .find((file) => existsSync(file));
}

const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
  );

rmSync(rekeyDirectory, { recursive: true, force: true });
mkdirSync(rekeyDirectory, { recursive: true });

let rewritten = 0;
let embeddings = 0;
for (const file of walk(recordedDirectory)) {
  const document = JSON.parse(readFileSync(file, "utf8"));
  const before = JSON.stringify(document);
  let moveTo;
  document.fixtures = document.fixtures.map((fixture) => {
    const context = fixture.match?.context;
    // Embeddings match by their input; the vectors stay as recorded.
    if (!context) return { ...fixture, match: rewrite(fixture.match) };
    const dump = dumpOf(context);
    const fixtureText = JSON.stringify(fixture);
    if (!dump) {
      assert(!forbidden?.test(fixtureText), `${context}: no request dump to rewrite`);
      return fixture;
    }
    const request = JSON.parse(readFileSync(dump, "utf8"));
    const next = rewrite(request);
    const nextFixture = rewrite(fixture);
    if (stableJson(next) === stableJson(request) && JSON.stringify(nextFixture) === fixtureText) {
      return fixture;
    }
    assert(!context.includes("--review-"), `${context}: panel reviews cannot be rewritten`);
    assert.deepEqual(volatileIds(next), volatileIds(request), `${context}: rewrite changed its IDs`);
    const nextContext = addRequestContext(next)._context;
    nextFixture.match.context = nextContext;
    writeFileSync(join(rekeyDirectory, `${nextContext}.json`), stableJson(next, 2));
    renameSync(join(idDirectory, `${context}.json`), join(idDirectory, `${nextContext}.json`));
    if (basename(dirname(file)) === context) moveTo = nextContext;
    rewritten += 1;
    return nextFixture;
  });
  if (JSON.stringify(document) === before) continue;
  if (!document.fixtures.some((fixture) => fixture.match?.context)) embeddings += 1;
  writeFileSync(file, JSON.stringify(document, null, 2));
  if (moveTo) renameSync(dirname(file), join(recordedDirectory, moveTo));
}

const left = forbidden
  ? walk(recordedDirectory).filter((file) => forbidden.test(readFileSync(file, "utf8")))
  : [];
console.log(`rewrote ${rewritten} fixtures and ${embeddings} embeddings; expected requests in ${rekeyDirectory}`);
if (left.length) {
  console.error(`still matching ${forbid}:\n${left.join("\n")}`);
  process.exit(1);
}
