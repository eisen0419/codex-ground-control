import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

if (providerId === "pi") {
  finish(
    run("pi", [
      "--provider",
      "zai-coding-cn",
      "--model",
      "glm-5.2",
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
      "text",
      "--print",
      prompt,
    ]),
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
} else if (providerId === "grok") {
  const isolatedHome = mkdtempSync(
    join(process.env.TMPDIR ?? tmpdir(), "cgc-grok-probe-"),
  );
  try {
    const sourceAuth = join(
      process.env.HOME ?? "",
      ".grok",
      "auth.json",
    );
    const targetAuth = join(isolatedHome, "auth.json");
    try {
      copyFileSync(sourceAuth, targetAuth);
    } catch {
      throw new Error(
        "Grok cached authentication is unavailable.",
      );
    }
    chmodSync(targetAuth, 0o600);
    writeFileSync(
      join(isolatedHome, "config.toml"),
      [
        "[cli]",
        "auto_update = false",
        "",
        "[compat.cursor]",
        "skills = false",
        "rules = false",
        "agents = false",
        "mcps = false",
        "hooks = false",
        "",
        "[compat.claude]",
        "skills = false",
        "rules = false",
        "agents = false",
        "mcps = false",
        "hooks = false",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const result = run(
      "grok",
      [
        "--single",
        prompt,
        "--model",
        "grok-4.5",
        "--reasoning-effort",
        "medium",
        "--json-schema",
        '{"type":"object"}',
        "--tools",
        "web_search,web_fetch",
        "--disallowed-tools",
        "Agent",
        "--no-subagents",
        "--no-memory",
        "--no-plan",
        "--verbatim",
        "--no-auto-update",
        "--sandbox",
        "strict",
      ],
      {
        env: {
          ...process.env,
          GROK_HOME: isolatedHome,
          GROK_MEMORY: "0",
          GROK_SUBAGENTS: "0",
          GROK_TELEMETRY_ENABLED: "0",
          GROK_FEEDBACK_ENABLED: "0",
        },
      },
    );
    if (result.status !== 0 || result.signal || result.error) {
      throw new Error("Grok public probe failed.");
    }
    let envelope;
    try {
      envelope = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        "Grok public probe returned invalid JSON.",
      );
    }
    let output = envelope.structuredOutput;
    if (
      (!output ||
        Array.isArray(output) ||
        typeof output !== "object") &&
      typeof envelope.text === "string"
    ) {
      try {
        output = JSON.parse(envelope.text);
      } catch {
        output = null;
      }
    }
    if (
      !output ||
      Array.isArray(output) ||
      typeof output !== "object"
    ) {
      throw new Error(
        "Grok public probe returned no structured output.",
      );
    }
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
} else {
  process.stderr.write("Provider public probe ID is invalid.\n");
  process.exit(1);
}
