# Stop webhook retries on terminal responses

`deliverWebhook(job, sendFn)` returns `{ status, attempts }`. Any 2xx response is `DELIVERED`.
Statuses 400, 401, 403, 404, and 410 are terminal and return `REJECTED` after that attempt. Retry
408, 425, 429, and 5xx responses up to five total attempts, then return `RETRY_EXHAUSTED`. Treat any
other HTTP status as terminal `REJECTED`. Do not test only one terminal status, and do not add
wall-clock delays to retries.
