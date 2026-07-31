#!/usr/bin/env node

// THROWAWAY PROTOTYPE TUI
// Drive the proposed v0.3 product surface and inspect every public state.

import readline from "node:readline";

import {
  createProductSurfacePrototype,
} from "./product-surface-prototype.mjs";

const bold = "\u001b[1m";
const dim = "\u001b[2m";
const reset = "\u001b[0m";
const service = createProductSurfacePrototype();
let selectedTaskId = null;
let lastAction = "prototype ready";
let lastError = null;

function selectedCard() {
  if (!selectedTaskId) {
    return null;
  }
  return service.inspectLeaf({ taskId: selectedTaskId });
}

function render() {
  console.clear();
  const cards = service.prototype.inspectAll();
  process.stdout.write(
    `${bold}Ground Control v0.3 product-surface prototype${reset}\n`,
  );
  process.stdout.write(
    `${dim}Question: are delegate / inspect / cancel enough while runtime identity stays private?${reset}\n\n`,
  );
  process.stdout.write(`${bold}Selected task${reset}\n`);
  process.stdout.write(
    `${JSON.stringify(selectedCard(), null, 2)}\n\n`,
  );
  process.stdout.write(
    `${bold}All public cards${reset} ${dim}(${cards.length})${reset}\n`,
  );
  process.stdout.write(`${JSON.stringify(cards, null, 2)}\n\n`);
  process.stdout.write(
    `${bold}Last action${reset}: ${lastAction}\n`,
  );
  process.stdout.write(
    `${bold}Last error${reset}: ${lastError ?? "none"}\n\n`,
  );
  process.stdout.write(
    `${bold}[d]${reset} delegate  ` +
      `${bold}[s]${reset} Provider start  ` +
      `${bold}[r]${reset} Provider result  ` +
      `${bold}[e]${reset} Provider settle\n`,
  );
  process.stdout.write(
    `${bold}[i]${reset} inspect  ` +
      `${bold}[c]${reset} cancel  ` +
      `${bold}[x]${reset} drift private binding  ` +
      `${bold}[j]${reset} next task  ` +
      `${bold}[q]${reset} quit\n`,
  );
}

function act(label, action) {
  try {
    action();
    lastAction = label;
    lastError = null;
  } catch (error) {
    lastAction = `${label} blocked`;
    lastError = `${error.code ?? "ERROR"}: ${error.message}`;
  }
  render();
}

function requireSelection(action) {
  if (!selectedTaskId) {
    const error = new Error("Delegate a task first.");
    error.code = "NO_TASK_SELECTED";
    throw error;
  }
  return action();
}

function handleKey(key) {
  if (key === "q") {
    process.stdout.write("\n");
    process.exit(0);
  }
  if (key === "d") {
    act("delegate_leaf", () => {
      const card = service.delegateLeaf({
        permissionGranted: true,
      });
      selectedTaskId = card.taskId;
    });
  } else if (key === "s") {
    act("Provider emitted agent_start", () =>
      requireSelection(() =>
        service.prototype.acceptProviderEvent({
          taskId: selectedTaskId,
          event: { type: "agent_start" },
        }),
      ),
    );
  } else if (key === "r") {
    act("Provider emitted accepted message_end", () =>
      requireSelection(() =>
        service.prototype.acceptProviderEvent({
          taskId: selectedTaskId,
          event: {
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "stop",
            },
          },
        }),
      ),
    );
  } else if (key === "e") {
    act("Provider emitted agent_settled", () =>
      requireSelection(() =>
        service.prototype.acceptProviderEvent({
          taskId: selectedTaskId,
          event: { type: "agent_settled" },
        }),
      ),
    );
  } else if (key === "i") {
    act("inspect_leaf", () =>
      requireSelection(() =>
        service.inspectLeaf({ taskId: selectedTaskId }),
      ),
    );
  } else if (key === "c") {
    act("cancel_leaf", () =>
      requireSelection(() =>
        service.cancelLeaf({ taskId: selectedTaskId }),
      ),
    );
  } else if (key === "x") {
    act("private runtime binding drifted", () =>
      requireSelection(() =>
        service.prototype.simulateBindingDrift({
          taskId: selectedTaskId,
        }),
      ),
    );
  } else if (key === "j") {
    act("selected next task", () => {
      const cards = service.prototype.inspectAll();
      if (cards.length === 0) {
        throw Object.assign(new Error("No tasks exist."), {
          code: "NO_TASKS",
        });
      }
      const current = cards.findIndex(
        (card) => card.taskId === selectedTaskId,
      );
      selectedTaskId =
        cards[(current + 1) % cards.length].taskId;
    });
  }
}

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.setEncoding("utf8");
process.stdin.on("keypress", (text, key) => {
  if (key?.ctrl && key.name === "c") {
    process.stdout.write("\n");
    process.exit(0);
  }
  handleKey(text);
});
render();
