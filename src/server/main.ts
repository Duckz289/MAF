import { createApp } from "./app";

const runtime = await createApp();
const port = Number(process.env.PORT ?? 4310);
const host = process.env.HOST ?? "127.0.0.1";

await runtime.app.listen({ port, host });

const shutdown = async (): Promise<void> => {
  await runtime.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
