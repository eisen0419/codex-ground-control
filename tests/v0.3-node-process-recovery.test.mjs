import assert from "node:assert/strict";
import { createInterface } from "node:readline";

const FIXTURE_FLAG = "--v0.3-offline-pi-rpc-fixture";

if (process.argv.includes(FIXTURE_FLAG)) {
  const sessionId = process.argv[
    process.argv.indexOf("--session-id") + 1
  ];
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const command = JSON.parse(line);
    const delayedStart =
      command.type === "prompt" && command.message === "fixture:start";
    const crash =
      command.type === "prompt" && command.message === "fixture:crash";
    const data =
      command.type === "get_state"
        ? { sessionId, isStreaming: false }
        : { accepted: true };
    if (command.type === "prompt" && !delayedStart && !crash) {
      process.stdout.write(
        JSON.stringify({ type: "agent_start", sessionId }) + "\n",
      );
    }
    if (command.type === "abort") {
      process.stdout.write(
        JSON.stringify({ type: "agent_settled", sessionId }) + "\n",
      );
    }
    process.stdout.write(
      JSON.stringify({
        type: "response",
        id: command.id,
        success: true,
        data,
      }) + "\n",
    );
    if (delayedStart) {
      setTimeout(() => {
        process.stdout.write(
          JSON.stringify({ type: "agent_start", sessionId }) + "\n",
        );
      }, 5);
    }
    if (crash) {
      setTimeout(() => process.exit(23), 5);
    }
  });
} else {
  const test = (await import("node:test")).default;
  const {
    createNodePiRpcProcessBoundary,
    createPiRpcAdapter,
  } = await import("../src/v0.3/pi-rpc-adapter.js");

  test("real Node RPC process recovers only by exact binding and leaves its sibling responsive", async (t) => {
    const boundary = createNodePiRpcProcessBoundary();
    t.after(() => boundary.close());
    const incarnations = ["incarnation-node-801", "incarnation-node-802"];
    const adapter = createPiRpcAdapter({
      processBoundary: boundary,
      idFactory: () => incarnations.shift(),
      command: process.execPath,
      commandArgs: [new URL(import.meta.url).pathname, FIXTURE_FLAG],
      requestTimeoutMs: 2_000,
    });
    const first = await adapter.start({
      taskId: "leaf-node-801",
      cwd: process.cwd(),
      modelProvider: "offline-fixture",
      model: "deterministic",
      sessionId: "00000000-0000-4000-8000-000000000801",
    });
    const sibling = await adapter.start({
      taskId: "leaf-node-802",
      cwd: process.cwd(),
      modelProvider: "offline-fixture",
      model: "deterministic",
      sessionId: "00000000-0000-4000-8000-000000000802",
    });
    await adapter.send({
      nativeSessionBinding: first.nativeSessionBinding,
      runtime: first.runtime,
      input: "offline start",
    });
    assert.equal(
      (await adapter.observe({
        nativeSessionBinding: first.nativeSessionBinding,
        runtime: first.runtime,
        afterSequence: 1,
      }))[0].signal.type,
      "turn.started",
    );

    const rebuilt = createPiRpcAdapter({
      processBoundary: boundary,
      requestTimeoutMs: 2_000,
    });
    const mismatch = await rebuilt.recover({
      taskId: "leaf-node-801",
      nativeSessionBinding: {
        ...first.nativeSessionBinding,
        processIncarnation: "wrong-incarnation",
      },
      afterSequence: 2,
    });
    assert.equal(mismatch, null);

    const wrongTask = await rebuilt.recover({
      taskId: "leaf-node-wrong",
      nativeSessionBinding: first.nativeSessionBinding,
      afterSequence: 2,
    });
    assert.equal(wrongTask, null);

    const recovered = await rebuilt.recover({
      taskId: "leaf-node-801",
      nativeSessionBinding: first.nativeSessionBinding,
      afterSequence: 2,
    });
    assert.ok(recovered);
    await assert.rejects(
      adapter.cancel({
        nativeSessionBinding: first.nativeSessionBinding,
        runtime: first.runtime,
      }),
      (error) => error?.code === "PI_RPC_ADAPTER_UNAVAILABLE",
    );
    await rebuilt.cancel({
      nativeSessionBinding: first.nativeSessionBinding,
      runtime: recovered.runtime,
    });
    assert.equal(
      (await rebuilt.observe({
        nativeSessionBinding: first.nativeSessionBinding,
        runtime: recovered.runtime,
        afterSequence: 2,
      }))[0].signal.type,
      "turn.settled",
    );

    await adapter.send({
      nativeSessionBinding: sibling.nativeSessionBinding,
      runtime: sibling.runtime,
      input: "sibling still responsive",
    });
    assert.equal(
      (await adapter.observe({
        nativeSessionBinding: sibling.nativeSessionBinding,
        runtime: sibling.runtime,
        afterSequence: 1,
      }))[0].signal.type,
      "turn.started",
    );
  });
}
