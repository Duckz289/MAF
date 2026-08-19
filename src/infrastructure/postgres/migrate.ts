import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

export const migrate = async (databaseUrl: string): Promise<void> => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const sql = await readFile(path.resolve(process.cwd(), "migrations/001_initial.sql"), "utf8");
    await pool.query(sql);
  } finally {
    await pool.end();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  await migrate(databaseUrl);
  process.stdout.write("Database migration completed\n");
}
