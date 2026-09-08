import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareOperationRequest } from "../../src/rpc/operation-request.js";

const server = { role: "workbench_server" as const };

describe("operation request preparation", () => {
  it("validates target, idempotency, and parameters through one path", () => {
    const prepared = prepareOperationRequest(
      "project.list",
      undefined,
      { target: server },
    );
    assert.equal(prepared.ok, true);
    if (prepared.ok) {
      assert.equal(prepared.data.method, "project.list");
      assert.equal(prepared.retryable, false);
    }

    const forbidden = prepareOperationRequest(
      "project.list",
      undefined,
      { target: { role: "ui" } },
    );
    assert.deepEqual(forbidden, {
      ok: false,
      error: {
        code: "AUTH_FORBIDDEN",
        message: "Operation project.list cannot target ui",
      },
    });

    const idempotency = prepareOperationRequest(
      "project.list",
      undefined,
      { target: server, idempotencyKey: "not-accepted" },
    );
    assert.equal(idempotency.ok, false);
  });
});
