import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  auditQualificationReceiptValidators,
  validateQualificationDocument,
  validateQualificationReceiptBehavior,
} from "../src/qualification-contract.js";
import { runOfflineQualification } from "../src/qualification-lab.js";

const campaign = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/qualification/offline-core-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function clone(value) {
  return structuredClone(value);
}

test("qualification schemas reject unknown fields and illegal states", () => {
  const homeDirectory = mkdtempSync(
    join(tmpdir(), "ground-control-contract-"),
  );
  try {
    const publicResult = runOfflineQualification({ homeDirectory });
    const runDirectory = join(
      homeDirectory,
      ".codex-ground-control",
      "evidence",
      "qualification",
      publicResult.runIdentity,
    );
    const result = JSON.parse(
      readFileSync(join(runDirectory, "results.json"), "utf8"),
    );
    const issues = JSON.parse(
      readFileSync(join(runDirectory, "issues.json"), "utf8"),
    );
    const receipt = {
      schemaVersion: "1",
      product: "codex-ground-control",
      version: "0.1.0",
      command: "qualify",
      status: "ok",
      exitCode: 0,
      projectRoot: "/workspace",
      changed: true,
      result: publicResult,
    };

    for (const [kind, document] of [
      ["campaign", campaign],
      ["result", result],
      ["issues", issues],
      ["receipt", receipt],
    ]) {
      assert.equal(
        validateQualificationDocument(kind, document).valid,
        true,
        `${kind} valid fixture was rejected`,
      );
      const unknown = clone(document);
      unknown.unexpected = true;
      assert.equal(
        validateQualificationDocument(kind, unknown).valid,
        false,
        `${kind} accepted an unknown field`,
      );
    }

    const illegalCampaign = clone(campaign);
    illegalCampaign.mode = "live";
    assert.equal(
      validateQualificationDocument(
        "campaign",
        illegalCampaign,
      ).valid,
      false,
    );

    const illegalResult = clone(result);
    illegalResult.terminalState = "complete";
    assert.equal(
      validateQualificationDocument("result", illegalResult).valid,
      false,
    );

    const illegalIssues = clone(issues);
    illegalIssues.openCount = -1;
    assert.equal(
      validateQualificationDocument("issues", illegalIssues).valid,
      false,
    );

    const illegalReceipt = clone(receipt);
    illegalReceipt.status = "complete";
    assert.equal(
      validateQualificationDocument("receipt", illegalReceipt).valid,
      false,
    );
    assert.equal(
      validateQualificationReceiptBehavior(illegalReceipt).valid,
      false,
    );
  } finally {
    rmSync(homeDirectory, { recursive: true, force: true });
  }
});

test("qualification receipt schema and public behavior decisions are audited", () => {
  assert.deepEqual(auditQualificationReceiptValidators(), {
    schemaVersion: "1",
    cases: 5,
    status: "audited",
  });
});
