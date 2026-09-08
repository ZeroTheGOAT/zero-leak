import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/** The project-scoped ZeroLeak AI directory name. */
export const PROJECT_DIR_NAME = ".zeroleak";

/**
 * The name upstream Nerve used. Projects configured under Nerve are still
 * read from their legacy location so the rebrand does not orphan them; every
 * file a project does not already have is written under the ZeroLeak name.
 */
export const LEGACY_PROJECT_DIR_NAME = ".nerve";

/**
 * Every directory to read project-level files from: the ZeroLeak location
 * first, then the legacy Nerve one. Both are returned whenever they exist,
 * because directory-shaped state is additive — once a new file is written
 * under the ZeroLeak name, the legacy directory must keep being read or its
 * remaining files would silently disappear. Callers that already skip
 * non-existent directories may pass both entries along unchecked.
 */
export function legacyProjectDirPaths(
  projectDir: string,
  ...segments: string[]
): string[] {
  const current = join(projectDir, PROJECT_DIR_NAME, ...segments);
  const legacy = join(projectDir, LEGACY_PROJECT_DIR_NAME, ...segments);
  const dirs = existsSync(current) ? [current] : [];
  if (existsSync(legacy)) dirs.push(legacy);
  return dirs;
}

/**
 * Where a project-level file is read from: the ZeroLeak location when it
 * exists, else the legacy Nerve location, else the ZeroLeak location — so an
 * absent file stays absent at the path a write will use. Intended for files
 * the operator authors by hand (project config, prompt resources): they keep
 * working where Nerve left them.
 */
export function legacyProjectFilePath(
  projectDir: string,
  ...segments: string[]
): string {
  const current = join(projectDir, PROJECT_DIR_NAME, ...segments);
  if (existsSync(current)) return current;
  const legacy = join(projectDir, LEGACY_PROJECT_DIR_NAME, ...segments);
  return existsSync(legacy) ? legacy : current;
}

/**
 * Where a project-level state file lives, adopting the legacy Nerve copy the
 * first time it is wanted. Server-managed state (permission overlays, project
 * permissions, task definitions) moves to the ZeroLeak name on first read, so
 * a project converges on one location instead of living split across both. A
 * move that fails — the legacy file is locked, say — falls back to reading it
 * where it is; nothing is lost either way.
 */
export function adoptProjectStateFile(
  projectDir: string,
  ...segments: string[]
): string {
  const current = join(projectDir, PROJECT_DIR_NAME, ...segments);
  if (existsSync(current)) return current;
  const legacy = join(projectDir, LEGACY_PROJECT_DIR_NAME, ...segments);
  if (!existsSync(legacy)) return current;
  try {
    mkdirSync(dirname(current), { recursive: true });
    renameSync(legacy, current);
    return current;
  } catch {
    return legacy;
  }
}
