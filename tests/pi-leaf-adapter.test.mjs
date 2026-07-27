import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runFleetJob } from "../src/fleet-runner.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const providerDirectory = join(
  repositoryRoot,
  "fixtures",
  "providers",
);

test("Pi live probe timeout is classified by the real leaf adapter boundary", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "cgc-pi-timeout-"));
  const providerBin = join(sandbox, "bin");
  const homeDirectory = join(sandbox, "home");
  const runsRoot = join(sandbox, "runs");
  mkdirSync(providerBin);
  mkdirSync(homeDirectory);
  mkdirSync(runsRoot);
  writeFileSync(
    join(providerBin, "pi"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      "  printf 'pi 1.2.3\\n'",
      "  exit 0",
      "fi",
      "sleep 5",
      "printf '{}\\n'",
      "",
    ].join("\n"),
  );
  chmodSync(join(providerBin, "pi"), 0o755);
  const manifest = JSON.parse(
    readFileSync(
      join(providerDirectory, "capabilities-v1.json"),
      "utf8",
    ),
  );
  const catalog = JSON.parse(
    readFileSync(
      join(providerDirectory, "public-probes-v1.json"),
      "utf8",
    ),
  );
  const originalEnvironment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
  };
  process.env.PATH = `${providerBin}:${originalEnvironment.PATH}`;
  process.env.HOME = homeDirectory;
  process.env.TMPDIR = sandbox;
  try {
    const receipt = await runFleetJob(
      {
        schemaVersion: "1",
        adapter: "pi-glm-live-probe",
        activity: "provider-qualification",
        prompt: catalog.providers["pi-glm"].prompt,
        timeoutMilliseconds: 100,
        outputContract: "pi-live-probe-output-v1",
      },
      manifest,
      {
        runsRoot,
        manifestDirectory: providerDirectory,
        runIdentityFactory: () => "pi-timeout-fixture",
      },
    );

    assert.equal(receipt.status, "timeout");
    assert.equal(receipt.outputContract.valid, false);
    assert.equal(receipt.adapter, "pi-glm-live-probe");
  } finally {
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Pi candidate adapter records verified runtime usage from message_end", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "cgc-pi-usage-"));
  const providerBin = join(sandbox, "bin");
  const homeDirectory = join(sandbox, "home");
  const runsRoot = join(sandbox, "runs");
  mkdirSync(providerBin);
  mkdirSync(homeDirectory);
  mkdirSync(runsRoot);
  const candidate = {
    schemaVersion: "1",
    profile: "pi-glm",
    provider: "zai-coding-cn",
    model: "glm-5.2",
    activity: "analysis",
    disposition: "candidate-evidence",
    completionAuthority: "codex-main",
    summary: "bounded candidate",
    findings: [],
    suggestedChecks: ["codex-main verifies"],
  };
  const usage = {
    input: 120,
    output: 30,
    cacheRead: 40,
    cacheWrite: 10,
    totalTokens: 200,
    cost: {
      input: 0.012,
      output: 0.006,
      cacheRead: 0.002,
      cacheWrite: 0.001,
      total: 0.021,
    },
  };
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "zai-coding-cn",
      model: "glm-5.2",
      content: [
        {
          type: "text",
          text: JSON.stringify(candidate),
        },
      ],
      usage,
      stopReason: "stop",
    },
  });
  writeFileSync(
    join(providerBin, "pi"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      "  printf 'pi 0.81.1\\n'",
      "  exit 0",
      "fi",
      `printf '%s\\n' '${messageEnd}'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(providerBin, "pi"), 0o755);
  const manifest = JSON.parse(
    readFileSync(
      join(providerDirectory, "capabilities-v1.json"),
      "utf8",
    ),
  );
  const originalEnvironment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    ZAI_CODING_CN_API_KEY:
      process.env.ZAI_CODING_CN_API_KEY,
  };
  process.env.PATH = `${providerBin}:${originalEnvironment.PATH}`;
  process.env.HOME = homeDirectory;
  process.env.TMPDIR = sandbox;
  process.env.ZAI_CODING_CN_API_KEY = "fixture-secret";
  try {
    const receipt = await runFleetJob(
      {
        schemaVersion: "1",
        adapter: "pi-glm",
        activity: "analysis",
        prompt: JSON.stringify({
          schemaVersion: "1",
          activity: "analysis",
          brief: "bounded brief",
        }),
        timeoutMilliseconds: 5000,
        outputContract: "pi-candidate-output-v1",
      },
      manifest,
      {
        runsRoot,
        manifestDirectory: providerDirectory,
        runIdentityFactory: () => "pi-usage-fixture",
      },
    );

    assert.equal(receipt.status, "succeeded");
    const output = JSON.parse(
      readFileSync(
        join(runsRoot, "pi-usage-fixture", "stdout.txt"),
        "utf8",
      ),
    );
    assert.deepEqual(output.candidate, candidate);
    assert.deepEqual(output.runtimeUsage, {
      schemaVersion: "1",
      source: "pi-message-end",
      status: "reported",
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      totalTokens: 200,
      cost: usage.cost,
    });

    const messageEndWithoutUsage = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "zai-coding-cn",
        model: "glm-5.2",
        content: [
          {
            type: "text",
            text: JSON.stringify(candidate),
          },
        ],
        stopReason: "stop",
      },
    });
    writeFileSync(
      join(providerBin, "pi"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        "  printf 'pi 0.81.1\\n'",
        "  exit 0",
        "fi",
        `printf '%s\\n' '${messageEndWithoutUsage}'`,
        "",
      ].join("\n"),
    );
    const unknownReceipt = await runFleetJob(
      {
        schemaVersion: "1",
        adapter: "pi-glm",
        activity: "analysis",
        prompt: JSON.stringify({
          schemaVersion: "1",
          activity: "analysis",
          brief: "bounded brief without usage",
        }),
        timeoutMilliseconds: 5000,
        outputContract: "pi-candidate-output-v1",
      },
      manifest,
      {
        runsRoot,
        manifestDirectory: providerDirectory,
        runIdentityFactory: () =>
          "pi-usage-unknown-fixture",
      },
    );
    assert.equal(unknownReceipt.status, "succeeded");
    const unknownOutput = JSON.parse(
      readFileSync(
        join(
          runsRoot,
          "pi-usage-unknown-fixture",
          "stdout.txt",
        ),
        "utf8",
      ),
    );
    assert.deepEqual(unknownOutput.runtimeUsage, {
      schemaVersion: "1",
      source: "pi-message-end",
      status: "unknown",
    });
  } finally {
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
});
