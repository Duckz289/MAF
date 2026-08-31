const MAX_ATTEMPTS = 5;
const TERMINAL_STATUSES = new Set([400, 401, 403, 404, 410]);
const RETRYABLE_STATUSES = new Set([408, 425, 429]);

const RULES = [
  { when: (status) => status >= 200 && status < 300, outcome: "DELIVERED" },
  { when: (status) => TERMINAL_STATUSES.has(status), outcome: "REJECTED" },
  { when: (status) => RETRYABLE_STATUSES.has(status), outcome: "RETRY" },
  { when: (status) => status >= 500 && status < 600, outcome: "RETRY" },
  { when: () => true, outcome: "REJECTED" },
];

const classify = (status) => RULES.find((rule) => rule.when(status)).outcome;

export async function deliverWebhook(job, sendFn) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const outcome = classify((await sendFn(job)).status);
    if (outcome !== "RETRY") return { status: outcome, attempts: attempt };
  }
  return { status: "RETRY_EXHAUSTED", attempts: MAX_ATTEMPTS };
}
