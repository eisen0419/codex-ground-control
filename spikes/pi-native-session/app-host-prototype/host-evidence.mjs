const PASSIVE_ITEM_TYPES = new Set([
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "plan",
  "reasoning",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
]);

function isTurnItem(notification, expected) {
  return (
    notification?.method === "item/completed" &&
    notification.params?.threadId === expected.threadId &&
    notification.params?.turnId === expected.turnId
  );
}

export function findCompletedMcpToolCall(
  notifications,
  expected,
) {
  return (
    notifications.find(
      (notification) =>
        isTurnItem(notification, expected) &&
        notification.params?.item?.type === "mcpToolCall" &&
        notification.params.item.server === expected.server &&
        notification.params.item.tool === expected.tool &&
        notification.params.item.status === "completed",
    ) ?? null
  );
}

export function requireExclusiveMcpToolCall(
  notifications,
  expected,
) {
  const actionItems = notifications.filter(
    (notification) =>
      isTurnItem(notification, expected) &&
      !PASSIVE_ITEM_TYPES.has(notification.params?.item?.type),
  );
  if (actionItems.length > 1) {
    throw new Error(
      "Host turn used another action besides the target tool.",
    );
  }
  const target = findCompletedMcpToolCall(
    actionItems,
    expected,
  );
  if (!target) {
    throw new Error(
      "Host turn did not complete the required target tool.",
    );
  }
  return target;
}
