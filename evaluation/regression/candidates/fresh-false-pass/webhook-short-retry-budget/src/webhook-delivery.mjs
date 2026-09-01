const TERMINAL = new Set([400, 401, 403, 404, 410]);
const SLOW_RETRY = new Set([408, 425, 429]);

export async function deliverWebhook(job, sendFn) {
  let attempt = 0;
  while (attempt < 5) {
    attempt += 1;
    const response = await sendFn(job);
    const status = response.status;
    if (status >= 200 && status < 300) return { status: "DELIVERED", attempts: attempt };
    if (TERMINAL.has(status)) return { status: "REJECTED", attempts: attempt };
    if (SLOW_RETRY.has(status)) {
      if (attempt >= 3) return { status: "RETRY_EXHAUSTED", attempts: attempt };
      continue;
    }
    if (status >= 500 && status < 600) continue;
    return { status: "REJECTED", attempts: attempt };
  }
  return { status: "RETRY_EXHAUSTED", attempts: 5 };
}
