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
