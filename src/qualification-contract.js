import { readFileSync } from "node:fs";

import { PACKAGE_VERSION } from "./package-metadata.js";

const SCHEMA_URLS = {
  campaign: new URL(
    "../schemas/qualification/campaign.schema.json",
    import.meta.url,
  ),
  result: new URL(
    "../schemas/qualification/result.schema.json",
    import.meta.url,
  ),
  issues: new URL(
    "../schemas/qualification/issue-ledger.schema.json",
    import.meta.url,
  ),
  receipt: new URL(
    "../schemas/qualification/public-receipt.schema.json",
    import.meta.url,
  ),
};

const RECEIPT_AUDIT_URL = new URL(
  "../fixtures/qualification/public-receipt-audit-v1.json",
  import.meta.url,
);

function readJson(url, label) {
  try {
    return JSON.parse(readFileSync(url, "utf8"));
  } catch {
    throw new Error(`${label} is unavailable or not valid JSON`);
  }
}

function jsonType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (Number.isInteger(value)) {
    return "integer";
  }
  if (typeof value === "number") {
    return "number";
  }
  return typeof value;
}

function matchesType(expected, value) {
  const actual = jsonType(value);
  if (expected === "number") {
    return actual === "number" || actual === "integer";
  }
  return actual === expected;
}

function validateNode(schema, value, location, errors) {
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.map((branch) => {
      const branchErrors = [];
      validateNode(branch, value, location, branchErrors);
      return branchErrors;
    });
    if (branches.filter((branch) => branch.length === 0).length !== 1) {
      errors.push(`${location} must match exactly one allowed shape`);
    }
    return;
  }

  const allowedTypes = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  if (
    allowedTypes.length > 0 &&
    !allowedTypes.some((type) => matchesType(type, value))
  ) {
    errors.push(
      `${location} must be ${allowedTypes.join(" or ")}`,
    );
    return;
  }

  if (
    Object.hasOwn(schema, "const") &&
    value !== schema.const
  ) {
    errors.push(`${location} must equal ${JSON.stringify(schema.const)}`);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.includes(value)
  ) {
    errors.push(`${location} has an illegal value`);
  }

  if (jsonType(value) === "object") {
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) {
        errors.push(`${location}.${key} is required`);
      }
    }
    for (const [key, nestedValue] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        validateNode(
          properties[key],
          nestedValue,
          `${location}.${key}`,
          errors,
        );
      } else if (schema.additionalProperties === false) {
        errors.push(`${location}.${key} is not allowed`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        validateNode(
          schema.additionalProperties,
          nestedValue,
          `${location}.${key}`,
          errors,
        );
      }
    }
    if (
      Number.isInteger(schema.minProperties) &&
      Object.keys(value).length < schema.minProperties
    ) {
      errors.push(
        `${location} must contain at least ${schema.minProperties} properties`,
      );
    }
  }

  if (jsonType(value) === "array") {
    if (
      Number.isInteger(schema.minItems) &&
      value.length < schema.minItems
    ) {
      errors.push(
        `${location} must contain at least ${schema.minItems} items`,
      );
    }
    if (
      Number.isInteger(schema.maxItems) &&
      value.length > schema.maxItems
    ) {
      errors.push(
        `${location} must contain at most ${schema.maxItems} items`,
      );
    }
    if (schema.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) {
        errors.push(`${location} must contain unique items`);
      }
    }
    if (schema.items) {
      value.forEach((item, index) =>
        validateNode(
          schema.items,
          item,
          `${location}[${index}]`,
          errors,
        )
      );
    }
  }

  if (typeof value === "string") {
    if (
      Number.isInteger(schema.minLength) &&
      value.length < schema.minLength
    ) {
      errors.push(
        `${location} must contain at least ${schema.minLength} characters`,
      );
    }
    if (
      Number.isInteger(schema.maxLength) &&
      value.length > schema.maxLength
    ) {
      errors.push(
        `${location} must contain at most ${schema.maxLength} characters`,
      );
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${location} does not match the required pattern`);
    }
    if (
      schema.format === "date-time" &&
      Number.isNaN(Date.parse(value))
    ) {
      errors.push(`${location} must be an ISO date-time`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${location} must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${location} must be at most ${schema.maximum}`);
    }
  }
}

export function validateQualificationDocument(kind, value) {
  const schemaUrl = SCHEMA_URLS[kind];
  if (!schemaUrl) {
    return {
      valid: false,
      errors: [`unknown qualification schema: ${kind}`],
    };
  }
  const errors = [];
  validateNode(
    readJson(schemaUrl, `${kind} schema`),
    value,
    "$",
    errors,
  );
  return { valid: errors.length === 0, errors };
}

export function assertQualificationDocument(kind, value) {
  const validation = validateQualificationDocument(kind, value);
  if (!validation.valid) {
    throw new Error(
      `${kind} schema validation failed: ${validation.errors.join("; ")}`,
    );
  }
  return value;
}

function hasExactKeys(value, required, optional = []) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object"
  ) {
    return false;
  }
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key)) &&
    Object.keys(value).length >= requiredSet.size
  );
}

function validCounts(counts) {
  return (
    hasExactKeys(counts, ["total", "passed", "failed"]) &&
    Number.isInteger(counts.total) &&
    Number.isInteger(counts.passed) &&
    Number.isInteger(counts.failed) &&
    counts.total > 0 &&
    counts.passed >= 0 &&
    counts.failed >= 0 &&
    counts.total === counts.passed + counts.failed
  );
}

function validError(error) {
  return (
    hasExactKeys(error, ["code", "message"]) &&
    /^[A-Z][A-Z0-9_]+$/.test(error.code) &&
    typeof error.message === "string" &&
    error.message.length > 0
  );
}

function validResultShape(result) {
  return (
    hasExactKeys(result, [
      "schemaVersion",
      "operation",
      "campaign",
      "terminalState",
      "campaignScope",
      "counts",
      "runIdentity",
      "evidence",
      "runtimeFingerprint",
      "network",
    ]) &&
    result.schemaVersion === "1" &&
    ["run", "reproduce", "verify"].includes(result.operation) &&
    typeof result.campaign === "string" &&
    result.campaign.length > 0 &&
    [
      "release-passed",
      "release-failed",
      "reproduction-passed",
      "reproduction-failed",
      "evidence-verified",
      "qualification-drifted",
    ].includes(result.terminalState) &&
    ["release-full", "single-scenario", "evidence"].includes(
      result.campaignScope,
    ) &&
    validCounts(result.counts) &&
    typeof result.runIdentity === "string" &&
    /^[a-zA-Z0-9-]+$/.test(result.runIdentity) &&
    hasExactKeys(result.evidence, ["index", "anchor"]) &&
    result.evidence.index ===
      `~/.codex-ground-control/evidence/qualification/` +
        `${result.runIdentity}/evidence-index.json` &&
    /^[0-9a-f]{64}$/.test(result.evidence.anchor) &&
    /^[0-9a-f]{64}$/.test(result.runtimeFingerprint) &&
    result.network === "not-used"
  );
}

function validDecision(receipt) {
  const { result } = receipt;
  const expected = {
    "release-passed": {
      operation: "run",
      campaignScope: "release-full",
      status: "ok",
      exitCode: 0,
      changed: true,
      error: false,
      failed: 0,
    },
    "release-failed": {
      operation: "run",
      campaignScope: "release-full",
      status: "blocked",
      exitCode: 2,
      changed: true,
      error: true,
    },
    "reproduction-passed": {
      operation: "reproduce",
      campaignScope: "single-scenario",
      status: "ok",
      exitCode: 0,
      changed: true,
      error: false,
      failed: 0,
      total: 1,
    },
    "reproduction-failed": {
      operation: "reproduce",
      campaignScope: "single-scenario",
      status: "blocked",
      exitCode: 2,
      changed: true,
      error: true,
      total: 1,
    },
    "evidence-verified": {
      operation: "verify",
      campaignScope: "evidence",
      status: "ok",
      exitCode: 0,
      changed: false,
      error: false,
    },
    "qualification-drifted": {
      operation: "verify",
      campaignScope: "evidence",
      status: "blocked",
      exitCode: 2,
      changed: false,
      error: true,
    },
  }[result.terminalState];
  if (!expected) {
    return false;
  }
  return (
    result.operation === expected.operation &&
    result.campaignScope === expected.campaignScope &&
    receipt.status === expected.status &&
    receipt.exitCode === expected.exitCode &&
    receipt.changed === expected.changed &&
    Object.hasOwn(receipt, "error") === expected.error &&
    (expected.failed === undefined ||
      result.counts.failed === expected.failed) &&
    (expected.total === undefined ||
      result.counts.total === expected.total) &&
    (result.terminalState.endsWith("failed")
      ? result.counts.failed > 0
      : true)
  );
}

export function validateQualificationReceiptBehavior(receipt) {
  const errors = [];
  if (
    !hasExactKeys(
      receipt,
      [
        "schemaVersion",
        "product",
        "version",
        "command",
        "status",
        "exitCode",
        "projectRoot",
        "changed",
      ],
      ["result", "error"],
    )
  ) {
    errors.push("public receipt fields do not match the v1 contract");
  }
  if (
    receipt?.schemaVersion !== "1" ||
    receipt?.product !== "codex-ground-control" ||
    receipt?.version !== PACKAGE_VERSION ||
    receipt?.command !== "qualify" ||
    typeof receipt?.projectRoot !== "string" ||
    receipt.projectRoot.length === 0
  ) {
    errors.push("public receipt identity is invalid");
  }

  if (!Object.hasOwn(receipt ?? {}, "result")) {
    if (
      receipt?.status !== "blocked" ||
      receipt?.exitCode !== 2 ||
      receipt?.changed !== false ||
      !validError(receipt?.error)
    ) {
      errors.push("operational blocker receipt is inconsistent");
    }
  } else if (
    !validResultShape(receipt.result) ||
    !validDecision(receipt) ||
    (Object.hasOwn(receipt, "error") && !validError(receipt.error))
  ) {
    errors.push("qualification result decision is inconsistent");
  }

  return { valid: errors.length === 0, errors };
}

export function auditQualificationReceiptValidators() {
  const audit = readJson(
    RECEIPT_AUDIT_URL,
    "qualification receipt audit fixture",
  );
  if (
    !hasExactKeys(audit, ["schemaVersion", "cases"]) ||
    audit.schemaVersion !== "1" ||
    !Array.isArray(audit.cases)
  ) {
    throw new Error("qualification receipt audit fixture has drifted");
  }

  const drift = [];
  for (const entry of audit.cases) {
    if (
      !hasExactKeys(entry, [
        "id",
        "schemaDecision",
        "behaviorDecision",
        "receipt",
      ]) ||
      typeof entry.id !== "string" ||
      typeof entry.schemaDecision !== "boolean" ||
      typeof entry.behaviorDecision !== "boolean"
    ) {
      drift.push("invalid audit case");
      continue;
    }
    const schemaDecision = validateQualificationDocument(
      "receipt",
      entry.receipt,
    ).valid;
    const behaviorDecision = validateQualificationReceiptBehavior(
      entry.receipt,
    ).valid;
    if (
      schemaDecision !== entry.schemaDecision ||
      behaviorDecision !== entry.behaviorDecision
    ) {
      drift.push(entry.id);
    }
  }
  if (drift.length > 0) {
    throw new Error(
      `qualification validator drift: ${drift.join(", ")}`,
    );
  }
  return {
    schemaVersion: "1",
    cases: audit.cases.length,
    status: "audited",
  };
}

export const qualificationSchemaUrls = Object.freeze({
  ...SCHEMA_URLS,
});
