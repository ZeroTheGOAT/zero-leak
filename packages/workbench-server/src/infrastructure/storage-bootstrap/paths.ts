import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  nerveHomeManifestSchema,
  resolveExplicitHome,
} from "@nervekit/contracts/settings";

export interface StoragePaths {
  home: string;
  /** The operating system user's home directory (not the ZeroLeak AI home). */
  userHome: string;
  manifestPath: string;
  daemonPath: string;
  configPath: string;
  daemonConfigPath: string;
  harnessConfigPath: string;
  uiConfigPath: string;
  permissionsConfigPath: string;
  providersConfigPath: string;
  integrationsConfigPath: string;
  secretsPath: string;
  masterKeyPath: string;
  credentialsPath: string;
  localTokenPath: string;
  dataPath: string;
  sqlitePath: string;
  conversationsPath: string;
  reportsPath: string;
  imagesPath: string;
  plansPath: string;
  tasksPath: string;
  agentPath: string;
  suggestionsPath: string;
  tlsPath: string;
  tmpPath: string;
  cachePath: string;
  queryCachePath: string;
  logsPath: string;
  crashesPath: string;
  migrationsPath: string;
  migrationLedgerPath: string;
  backupsPath: string;
}

export function resolveDataDir(
  explicitHome = resolveExplicitHome(
    process.env.ZEROLEAK_HOME,
    process.env.NERVE_HOME,
  ),
): string {
  if (explicitHome?.trim()) return explicitHome;
  const home = join(homedir(), ".zeroleak");
  adoptLegacyNerveHome(home, join(homedir(), ".nerve"));
  return home;
}

/**
 * Adopts the legacy `~/.nerve` home as `~/.zeroleak`, once. Upstream Nerve
 * wrote the same nerve-home layout, so a rename carries everything —
 * settings, projects, conversations, secrets — over intact. Adoption happens
 * only when the ZeroLeak home has nothing to lose and the legacy home carries
 * a manifest this version understands; anything else is left for the operator
 * to move by hand. Explicit `ZEROLEAK_HOME`/`NERVE_HOME` values never pass
 * through here: they name a directory on purpose.
 *
 * Exported for tests.
 */
export function adoptLegacyNerveHome(home: string, legacy: string): void {
  try {
    if (!isCurrentNerveHome(legacy)) return;
    if (existsSync(home)) {
      // An already-initialized home wins; an empty directory is the only
      // thing safe to replace.
      if (readdirSync(home).length > 0) return;
      rmdirSync(home);
    }
    renameSync(legacy, home);
  } catch {
    // Adoption is best effort: on any surprise — a locked file in the legacy
    // home on Windows, say — the daemon starts with a fresh home rather than
    // failing to boot.
  }
}

/** Whether a directory is a nerve-home layout this version can read. */
function isCurrentNerveHome(home: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(home, "manifest.json"), "utf8"),
    );
    return nerveHomeManifestSchema.safeParse(manifest).success;
  } catch {
    return false;
  }
}

export function storagePaths(home = resolveDataDir()): StoragePaths {
  const configPath = join(home, "config");
  const secretsPath = join(home, "secrets");
  const dataPath = join(home, "data");
  const agentPath = join(home, "agent");
  const migrationsPath = join(home, "migrations");
  const cachePath = join(home, "cache");
  return {
    home,
    userHome: homedir(),
    manifestPath: join(home, "manifest.json"),
    daemonPath: join(home, "daemon.json"),
    configPath,
    daemonConfigPath: join(configPath, "daemon.json"),
    harnessConfigPath: join(configPath, "harness.json"),
    uiConfigPath: join(configPath, "ui.json"),
    permissionsConfigPath: join(configPath, "permissions.json"),
    providersConfigPath: join(configPath, "providers.json"),
    integrationsConfigPath: join(configPath, "integrations.json"),
    secretsPath,
    masterKeyPath: join(secretsPath, "master.key"),
    credentialsPath: join(secretsPath, "credentials.enc"),
    localTokenPath: join(secretsPath, "daemon-token"),
    dataPath,
    sqlitePath: join(dataPath, "nerve.sqlite"),
    conversationsPath: join(dataPath, "conversations"),
    reportsPath: join(dataPath, "reports"),
    imagesPath: join(dataPath, "images"),
    plansPath: join(dataPath, "plans"),
    tasksPath: join(dataPath, "tasks"),
    agentPath,
    suggestionsPath: join(agentPath, "suggestions"),
    tlsPath: join(home, "tls"),
    tmpPath: join(home, "tmp"),
    cachePath,
    queryCachePath: join(cachePath, "query-cache.sqlite"),
    logsPath: join(home, "logs"),
    crashesPath: join(home, "crashes"),
    migrationsPath,
    migrationLedgerPath: join(migrationsPath, "ledger.json"),
    backupsPath: join(home, "backups"),
  };
}
