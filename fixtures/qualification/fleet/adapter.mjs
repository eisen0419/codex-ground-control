#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const mode = process.argv[2];
const prompt = process.argv[3] ?? "";
const payload = {
  ok: true,
  marker: "FLEET_FIXTURE_V1",
  prompt,
  secretPresent:
    process.env.FLEETRUNNER_UNAUTHORIZED_SECRET !== undefined,
  workspaceMarkerPresent: existsSync("fixture.txt"),
};

if (mode === "raw") {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} else if (mode === "fenced") {
  process.stdout.write(
    `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`,
  );
} else if (mode === "nonzero") {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.stderr.write("fixture process failure\n");
  process.exitCode = 7;
} else if (mode === "invalid-json") {
  process.stdout.write("not-json\n");
} else if (mode === "trailing-prose") {
  process.stdout.write(`${JSON.stringify(payload)}\ntrailing prose\n`);
} else if (mode === "multiple-fences") {
  process.stdout.write(
    `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n` +
      `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`,
  );
} else if (mode === "corrupt-payload") {
  process.stdout.write(
    `${JSON.stringify({ ...payload, ok: "true" })}\n`,
  );
} else if (mode === "timeout-process-group") {
  spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import {writeFileSync} from "node:fs";' +
        'process.on("SIGTERM", () => {});' +
        "setTimeout(() => " +
        'writeFileSync("descendant-survived.txt", "survived\\n"), 500);',
    ],
    { stdio: "ignore" },
  );
  setInterval(() => {}, 1000);
} else if (mode === "stdout-flood") {
  process.stdout.write(Buffer.alloc(8192, 0xff));
} else if (mode === "stderr-flood") {
  process.stderr.write("x".repeat(8192));
} else {
  process.stderr.write("unknown FleetRunner fixture mode\n");
  process.exitCode = 2;
}
