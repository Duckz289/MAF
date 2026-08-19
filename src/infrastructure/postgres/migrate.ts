import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

export const migrate = async (databaseUrl: string): Promise<void> => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const directory = path.resolve(process.cwd(), "migrations");
    const migrations = (await readdir(directory))
      .filter((file) => /^\d+_.+\.sql$/u.test(file))
      .sort();
    for (const migration of migrations) {
      const sql = await readFile(path.join(directory, migration), "utf8");
      await pool.query(sql);
    }
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
