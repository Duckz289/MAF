import { spawnSync } from "node:child_process";

const explicitBinary = process.env.DOCKER_COMPOSE_BIN;
const candidates = [
  ...(explicitBinary ? [{ command: explicitBinary, args: ["config", "--quiet"] }] : []),
  { command: "docker", args: ["compose", "config", "--quiet"] },
  {
    command: process.platform === "win32" ? "docker-compose.exe" : "docker-compose",
    args: ["config", "--quiet"],
  },
];

for (const candidate of candidates) {
  const result = spawnSync(candidate.command, candidate.args, { stdio: "inherit" });
  if (result.error?.code === "ENOENT") continue;
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

console.error(
  "Compose is unavailable. Install Docker Compose or set DOCKER_COMPOSE_BIN to a standalone Compose executable.",
);
process.exit(1);
