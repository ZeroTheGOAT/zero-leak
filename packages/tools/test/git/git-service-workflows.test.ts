import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GitWorkflowError } from "../../src/git/git-errors.js";
import { GitService } from "../../src/git/git-service.js";

type RepositoryFixture = {
  root: string;
  work: string;
  updater: string;
  service: GitService;
};

/**
 * Pin line-ending translation for every fixture invocation so committed
 * content round-trips byte-exactly no matter what the host's global
 * `core.autocrlf` is (Git for Windows defaults it to `true`). The flags are
 * passed per-command rather than via `git config` because `clone` and `init`
 * create the very repositories the settings must already apply to.
 */
const HERMETIC_GIT_CONFIG = ["-c", "core.autocrlf=false", "-c", "core.eol=lf"];

async function command(
  service: GitService,
  cwd: string,
  ...args: string[]
): Promise<void> {
  await service.runGit(cwd, [...HERMETIC_GIT_CONFIG, ...args]);
}

async function configureRepository(
  service: GitService,
  cwd: string,
): Promise<void> {
  await command(service, cwd, "config", "user.name", "ZeroLeak AI Test");
  await command(service, cwd, "config", "user.email", "nerve@example.test");
  // Persist the same line-ending policy into the repository so the GitService
  // calls under test — which spawn Git without the fixture's -c flags — keep
  // checking content out verbatim.
  await command(service, cwd, "config", "core.autocrlf", "false");
  await command(service, cwd, "config", "core.eol", "lf");
}

async function createFixture(): Promise<RepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), "nerve-git-workflow-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const work = join(root, "work");
  const updater = join(root, "updater");
  const service = new GitService(() => ({ dir: work, name: "work" }));

  await command(
    service,
    root,
    "init",
    "--bare",
    "--initial-branch=main",
    remote,
  );
  await command(service, root, "init", "--initial-branch=main", seed);
  await configureRepository(service, seed);
  await writeFile(join(seed, "local.txt"), "initial local\n");
  await writeFile(join(seed, "shared.txt"), "initial shared\n");
  await writeFile(join(seed, "upstream.txt"), "initial upstream\n");
  await command(service, seed, "add", ".");
  await command(service, seed, "commit", "-m", "initial");
  await command(service, seed, "remote", "add", "origin", remote);
  await command(service, seed, "push", "-u", "origin", "main");
  await command(service, root, "clone", remote, work);
  await command(service, root, "clone", remote, updater);
  await configureRepository(service, work);
  await configureRepository(service, updater);

  return { root, work, updater, service };
}

async function pushUpstreamChange(
  fixture: RepositoryFixture,
  path: string,
  content: string,
): Promise<void> {
  await writeFile(join(fixture.updater, path), content);
  await command(fixture.service, fixture.updater, "add", path);
  await command(
    fixture.service,
    fixture.updater,
    "commit",
    "-m",
    `update ${path}`,
  );
  await command(fixture.service, fixture.updater, "push");
}

async function withFixture(
  run: (fixture: RepositoryFixture) => Promise<void>,
): Promise<void> {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

describe("GitService dirty-worktree workflows", () => {
  it("pulls a fast-forward while preserving a non-overlapping local change", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.work, "local.txt"), "local edit\n");
      await pushUpstreamChange(fixture, "upstream.txt", "upstream edit\n");

      const result = await fixture.service.pull("project", ".");

      assert.equal(result.repo.dirty, true);
      assert.equal(
        await readFile(join(fixture.work, "local.txt"), "utf8"),
        "local edit\n",
      );
      assert.equal(
        await readFile(join(fixture.work, "upstream.txt"), "utf8"),
        "upstream edit\n",
      );
    });
  });

  it("switches to base and pulls while preserving a compatible local change", async () => {
    await withFixture(async (fixture) => {
      await command(fixture.service, fixture.work, "switch", "-c", "feature");
      await writeFile(join(fixture.work, "local.txt"), "feature edit\n");
      await pushUpstreamChange(fixture, "upstream.txt", "updated on main\n");

      const result = await fixture.service.switchBaseAndPull("project", ".");

      assert.equal(result.repo.currentBranch, "main");
      assert.equal(result.repo.dirty, true);
      assert.equal(
        await readFile(join(fixture.work, "local.txt"), "utf8"),
        "feature edit\n",
      );
      assert.equal(
        await readFile(join(fixture.work, "upstream.txt"), "utf8"),
        "updated on main\n",
      );
    });
  });

  it("syncs a behind branch while preserving a non-overlapping local change", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.work, "local.txt"), "local sync edit\n");
      await pushUpstreamChange(fixture, "upstream.txt", "synced upstream\n");

      const result = await fixture.service.syncBranch("project", ".");

      assert.equal(result.repo.dirty, true);
      assert.equal(
        await readFile(join(fixture.work, "local.txt"), "utf8"),
        "local sync edit\n",
      );
      assert.equal(
        await readFile(join(fixture.work, "upstream.txt"), "utf8"),
        "synced upstream\n",
      );
    });
  });

  it("lets Git reject an overlapping pull without changing the local file", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.work, "shared.txt"), "local version\n");
      await pushUpstreamChange(fixture, "shared.txt", "upstream version\n");

      await assert.rejects(
        fixture.service.pull("project", "."),
        (error: unknown) =>
          error instanceof GitWorkflowError &&
          error.code === "GIT_COMMAND_FAILED",
      );
      assert.equal(
        await readFile(join(fixture.work, "shared.txt"), "utf8"),
        "local version\n",
      );
    });
  });
});
