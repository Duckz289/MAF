const MAX_ATTEMPTS = 5;
const TERMINAL = new Set([400, 401, 403, 404, 408, 410, 425]);

export async function deliverWebhook(job, sendFn) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await sendFn(job);
    const status = response.status;
    if (status >= 200 && status < 300) return { status: "DELIVERED", attempts: attempt };
    if (TERMINAL.has(status)) return { status: "REJECTED", attempts: attempt };
    if (status === 429 || (status >= 500 && status < 600)) continue;
    return { status: "REJECTED", attempts: attempt };
  }
  return { status: "RETRY_EXHAUSTED", attempts: MAX_ATTEMPTS };
}
