import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { refreshAll } from "../web/lib/kb";

function loadWebEnv(): void {
  const candidates = [
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), "web/.env.local"),
    resolve(process.cwd(), "../web/.env.local"),
  ];
  const envPath = candidates.find((candidate) => existsSync(candidate));
  if (!envPath) return;

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  loadWebEnv();
  const results = await refreshAll();

  for (const result of results) {
    const suffix =
      result.status === "error"
        ? `error=${result.error}`
        : `chunks=${result.chunkCount ?? 0} hash=${result.textHash ?? "n/a"}`;
    console.log(`${result.key}: ${result.status} (${suffix})`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
