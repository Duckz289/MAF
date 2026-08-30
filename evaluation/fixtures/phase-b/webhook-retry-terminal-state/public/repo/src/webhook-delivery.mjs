const MAX_ATTEMPTS = 5;

export async function deliverWebhook(job, sendFn) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await sendFn(job);
    if (response.status >= 200 && response.status < 300) {
      return { status: "DELIVERED", attempts: attempt };
    }
  }
}
