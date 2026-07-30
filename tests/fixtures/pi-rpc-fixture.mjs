import readline from "node:readline";

const sessionIdIndex = process.argv.indexOf("--session-id");
const sessionId =
  sessionIdIndex >= 0
    ? process.argv[sessionIdIndex + 1]
    : "fixture-session-missing";
let isStreaming = false;
let abortCount = 0;

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    output({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: {
        sessionId,
        sessionFile: `/fixture/${sessionId}.jsonl`,
        ambientSecretPresent: Boolean(
          process.env.PI_RPC_AMBIENT_SECRET_FOR_TEST,
        ),
        allowedMarkerPresent:
          process.env.PI_RPC_ALLOWED_MARKER === "allowed",
        isStreaming,
        isCompacting: false,
        thinkingLevel: "off",
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: false,
        messageCount: 0,
        pendingMessageCount: 0,
        abortCount,
      },
    });
    return;
  }
  if (command.type === "prompt") {
    const failureSecret =
      process.env.PI_RPC_FIXTURE_PROMPT_FAILURE_SECRET;
    if (failureSecret) {
      process.stderr.write(`fixture stderr: ${failureSecret}\n`);
      output({
        id: command.id,
        type: "response",
        command: "prompt",
        success: false,
        error: `fixture error: ${failureSecret}`,
      });
      return;
    }
    isStreaming = true;
    output({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
    });
    output({ type: "agent_start" });
    return;
  }
  if (command.type === "abort") {
    abortCount += 1;
    isStreaming = false;
    output({
      id: command.id,
      type: "response",
      command: "abort",
      success: true,
    });
    output({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "aborted",
        content: [],
      },
    });
    output({
      type: "agent_end",
      messages: [],
      willRetry: false,
    });
    output({ type: "agent_settled" });
  }
});

process.on("SIGTERM", () => {
  lines.close();
  process.exit(0);
});
