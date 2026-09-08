import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NERVE_HOME_MANIFEST } from "@nervekit/contracts/settings";
import {
  adoptProjectStateFile,
  LEGACY_PROJECT_DIR_NAME,
  legacyProjectFilePath,
  PROJECT_DIR_NAME,
} from "../../src/infrastructure/configuration/legacy-project-paths.js";
import {
  adoptLegacyNerveHome,
} from "../../src/infrastructure/storage-bootstrap/paths.js";

async function temporaryDir(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

test("legacyProjectFilePath prefers the ZeroLeak copy and falls back to the Nerve one", async (t) => {
  const project = await temporaryDir("legacy-project-read-");
  t.after(() => rm(project, { recursive: true, force: true }));

  // Neither location exists: the write location is returned so an absent
  // file stays absent.
  assert.equal(
    legacyProjectFilePath(project, "config", "harness.json"),
    join(project, PROJECT_DIR_NAME, "config", "harness.json"),
  );

  // Only the legacy copy exists: it is read where Nerve left it.
  await mkdir(join(project, LEGACY_PROJECT_DIR_NAME), { recursive: true });
  await writeFile(
    join(project, LEGACY_PROJECT_DIR_NAME, "SYSTEM.md"),
    "legacy",
    "utf8",
  );
  assert.equal(
    legacyProjectFilePath(project, "SYSTEM.md"),
    join(project, LEGACY_PROJECT_DIR_NAME, "SYSTEM.md"),
  );

  // A ZeroLeak copy, once written, wins.
  await mkdir(join(project, PROJECT_DIR_NAME), { recursive: true });
  await writeFile(
    join(project, PROJECT_DIR_NAME, "SYSTEM.md"),
    "current",
    "utf8",
  );
  assert.equal(
    legacyProjectFilePath(project, "SYSTEM.md"),
    join(project, PROJECT_DIR_NAME, "SYSTEM.md"),
  );
});

test("adoptProjectStateFile moves the legacy copy once and then keeps using the new location", async (t) => {
  const project = await temporaryDir("legacy-project-adopt-");
  t.after(() => rm(project, { recursive: true, force: true }));

  await mkdir(join(project, LEGACY_PROJECT_DIR_NAME, "config"), {
    recursive: true,
  });
  await writeFile(
    join(project, LEGACY_PROJECT_DIR_NAME, "config", "permissions.json"),
    "{}",
    "utf8",
  );

  const adopted = adoptProjectStateFile(
    project,
    "config",
    "permissions.json",
  );
  assert.equal(
    adopted,
    join(project, PROJECT_DIR_NAME, "config", "permissions.json"),
  );
  assert.equal(
    await readFile(adopted, "utf8"),
    "{}",
    "the state moved, contents intact",
  );
  await assert.rejects(
    readFile(join(project, LEGACY_PROJECT_DIR_NAME, "config", "permissions.json")),
    /ENOENT/,
    "the legacy copy is gone after adoption",
  );

  // A second lookup resolves to the adopted location without any legacy
  // directory existing.
  assert.equal(
    adoptProjectStateFile(project, "config", "permissions.json"),
    adopted,
  );

  // With nothing to adopt the write location is returned directly.
  assert.equal(
    adoptProjectStateFile(project, "tasks", "definitions.json"),
    join(project, PROJECT_DIR_NAME, "tasks", "definitions.json"),
  );
});

test("adoptLegacyNerveHome renames a current legacy home over a fresh target", async (t) => {
  const root = await temporaryDir("legacy-home-adopt-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = join(root, "legacy");
  const home = join(root, "zeroleak");

  await mkdir(join(legacy, "config"), { recursive: true });
  await writeFile(join(legacy, "manifest.json"), JSON.stringify(NERVE_HOME_MANIFEST), "utf8");
  await writeFile(join(legacy, "config", "harness.json"), "{}", "utf8");

  adoptLegacyNerveHome(home, legacy);

  assert.equal(
    await readFile(join(home, "manifest.json"), "utf8"),
    JSON.stringify(NERVE_HOME_MANIFEST),
    "the whole home carried over by rename",
  );
  assert.equal(await readFile(join(home, "config", "harness.json"), "utf8"), "{}");
  await assert.rejects(readFile(join(legacy, "manifest.json")), /ENOENT/);
});

test("adoptLegacyNerveHome leaves non-legacy or occupied directories alone", async (t) => {
  const root = await temporaryDir("legacy-home-skip-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = join(root, "legacy");
  const home = join(root, "zeroleak");

  // A directory without a current nerve-home manifest is not adopted.
  await mkdir(legacy, { recursive: true });
  adoptLegacyNerveHome(home, legacy);
  assert.ok(!existsSync(home));
  await writeFile(join(legacy, "manifest.json"), JSON.stringify({ format: "nerve-home", version: 99 }), "utf8");
  adoptLegacyNerveHome(home, legacy);
  assert.ok(!existsSync(home), "an unknown manifest version is left for the operator");

  // A manifest this version understands, but an occupied target: no rename.
  await writeFile(join(legacy, "manifest.json"), JSON.stringify(NERVE_HOME_MANIFEST), "utf8");
  await writeFile(join(legacy, "config-harness.txt"), "occupied", "utf8");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "occupied.txt"), "target", "utf8");
  adoptLegacyNerveHome(home, legacy);
  assert.equal(await readFile(join(home, "occupied.txt"), "utf8"), "target");
  assert.equal(await readFile(join(legacy, "manifest.json"), "utf8"), JSON.stringify(NERVE_HOME_MANIFEST));

  // An empty target directory is the one thing safe to replace.
  await mkdir(join(root, "empty-target"), { recursive: true });
  adoptLegacyNerveHome(join(root, "empty-target"), legacy);
  assert.equal(
    await readFile(join(root, "empty-target", "manifest.json"), "utf8"),
    JSON.stringify(NERVE_HOME_MANIFEST),
  );
});
