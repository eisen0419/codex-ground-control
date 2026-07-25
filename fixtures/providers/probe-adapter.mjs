import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const providerId = process.argv[2];
const prompt = process.argv[3];
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
let catalog;
try {
  catalog = JSON.parse(
    readFileSync(
      join(fixtureDirectory, "public-probes-v1.json"),
      "utf8",
    ),
  );
} catch {
  process.stderr.write("Provider public probe contract is unavailable.\n");
  process.exit(1);
}
const record = catalog.providers?.[providerId];
if (!record || prompt !== record.prompt) {
  process.stderr.write("Provider public probe prompt is not approved.\n");
  process.exit(1);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: false,
    timeout: 110000,
    maxBuffer: 65536,
  });
}

function finish(result) {
  if (result.status !== 0 || result.signal || result.error) {
    process.stderr.write("Provider public probe failed.\n");
    process.exit(1);
  }
  process.stdout.write(result.stdout);
}

function finishPi(result, record) {
  if (result.status !== 0 || result.signal || result.error) {
    process.stderr.write("Provider public probe failed.\n");
    process.exit(1);
  }
  const events = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {
      process.stderr.write(
        "Pi public probe returned an invalid event stream.\n",
      );
      process.exit(1);
    }
  }
  const assistantEvents = events.filter(
    (event) =>
      event?.type === "message_end" &&
      event.message?.role === "assistant",
  );
  if (assistantEvents.length !== 1) {
    process.stderr.write(
      "Pi public probe returned no unique assistant identity event.\n",
    );
    process.exit(1);
  }
  const message = assistantEvents[0].message;
  if (
    message.provider !== record.contract.provider ||
    message.model !== record.contract.model
  ) {
    process.stderr.write(
      "Pi public probe runtime identity did not match the requested profile.\n",
    );
    process.exit(1);
  }
  const textBlocks = Array.isArray(message.content)
    ? message.content.filter((content) => content?.type === "text")
    : [];
  if (
    message.stopReason !== "stop" ||
    !Array.isArray(message.content) ||
    message.content.some(
      (content) =>
        content?.type !== "text" &&
        content?.type !== "thinking",
    ) ||
    textBlocks.length !== 1 ||
    typeof textBlocks[0].text !== "string"
  ) {
    process.stderr.write(
      "Pi public probe returned no unique text result.\n",
    );
    process.exit(1);
  }
  process.stdout.write(`${textBlocks[0].text}\n`);
}

function runPi(args) {
  const home = join(process.cwd(), ".pi-home");
  mkdirSync(home, { mode: 0o700 });
  try {
    return run("pi", args, {
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: join(home, "agent"),
        PI_CODING_AGENT_SESSION_DIR: join(home, "sessions"),
        PI_TELEMETRY: "0",
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (providerId.startsWith("pi-")) {
  if (
    record.contract?.kind !== "model" ||
    typeof record.contract.provider !== "string" ||
    typeof record.contract.model !== "string"
  ) {
    process.stderr.write("Pi profile identity is invalid.\n");
    process.exit(1);
  }
  finishPi(
    runPi([
        "--provider",
        record.contract.provider,
        "--model",
        record.contract.model,
        "--thinking",
        "medium",
        "--no-tools",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-approve",
        "--system-prompt",
        "You are a fixed public qualification probe. Return exactly one raw JSON object with no Markdown or prose.",
        "--mode",
        "json",
        "--print",
        prompt,
      ]),
    record,
  );
} else if (providerId === "agy") {
  finish(
    run("agy", [
      "--sandbox",
      "--mode",
      "plan",
      "--model",
      "gemini-3.6-flash-high",
      "--print-timeout",
      "2m",
      "--print",
      prompt,
    ]),
  );
} else {
  process.stderr.write("Provider public probe ID is invalid.\n");
  process.exit(1);
}
