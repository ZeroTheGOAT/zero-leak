import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayVersion } from "./release-version";

describe("release version display", () => {
  it("accepts v prefixes and strips them exactly once", () => {
    assert.equal(displayVersion("v0.15.0"), "v0.15.0");
    assert.equal(displayVersion("0.15.0"), "v0.15.0");
  });
});
