import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  agySourceObservationMatches,
  verifyAgySourceObservation,
} from "../fixtures/providers/agy-source-verifier.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(
  readFileSync(
    join(
      repositoryRoot,
      "fixtures",
      "providers",
      "public-probes-v1.json",
    ),
    "utf8",
  ),
);
const rules = catalog.providers.agy.sourceRules;
const now = Date.parse("2026-07-26T00:00:00.000Z");

function observation(overrides = {}) {
  return {
    url: "https://www.python.org/",
    identity: "Python Software Foundation official website",
    observedAt: "2026-07-25T23:59:59.000Z",
    ...overrides,
  };
}

test("AGY verifier independently fetches one allowlisted public source", async () => {
  const calls = [];
  const evidence = await verifyAgySourceObservation(
    observation(),
    rules,
    {
      now,
      startedAt: now - 2_000,
      fetchImplementation: async (url, options) => {
        calls.push({ url: url.href, options });
        return new Response(
          "<html><title>Welcome to Python.org</title></html>",
          { status: 200 },
        );
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://www.python.org/");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(
    calls[0].options.headers["user-agent"],
    "codex-ground-control/0.2",
  );
  assert.deepEqual(evidence, {
    checkedAt: "2026-07-26T00:00:00.000Z",
    finalUrl: "https://www.python.org/",
    httpStatus: 200,
    contentMarkersMatched: true,
    verified: true,
  });
});

test("AGY verifier rejects stale, credentialed, queried, and wrong-identity observations before fetch", async () => {
  const invalid = [
    observation({ observedAt: "2020-01-01T00:00:00.000Z" }),
    observation({
      url: "https://user:secret@www.python.org/",
    }),
    observation({ url: "https://www.python.org" }),
    observation({ url: "https://www.python.org/?source=google" }),
    observation({ identity: "Python community website" }),
  ];
  for (const source of invalid) {
    let fetched = false;
    assert.equal(
      agySourceObservationMatches(source, rules, {
        now,
        startedAt: now - 2_000,
      }),
      false,
    );
    await assert.rejects(
      verifyAgySourceObservation(source, rules, {
        now,
        startedAt: now - 2_000,
        fetchImplementation: async () => {
          fetched = true;
          return new Response("Python", { status: 200 });
        },
      }),
      /not allowlisted/,
    );
    assert.equal(fetched, false);
  }
});

test("AGY verifier rejects redirects outside the exact origin and path allowlist", async () => {
  let calls = 0;
  await assert.rejects(
    verifyAgySourceObservation(observation(), rules, {
      now,
      startedAt: now - 2_000,
      fetchImplementation: async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://example.com/lookalike",
          },
        });
      },
    }),
    /redirect is not allowlisted/,
  );
  assert.equal(calls, 1);
});

test("AGY verifier bounds source bytes and requires successful semantic content", async () => {
  await assert.rejects(
    verifyAgySourceObservation(
      observation(),
      rules,
      {
        now,
        startedAt: now - 2_000,
        fetchImplementation: async () =>
          new Response(`Python${"x".repeat(1_000_000)}`, {
            status: 200,
          }),
      },
    ),
    /byte limit/,
  );
  for (const response of [
    new Response("unrelated content", { status: 200 }),
    new Response("Python", { status: 503 }),
  ]) {
    await assert.rejects(
      verifyAgySourceObservation(observation(), rules, {
        now,
        startedAt: now - 2_000,
        fetchImplementation: async () => response,
      }),
      /could not be verified/,
    );
  }
});
