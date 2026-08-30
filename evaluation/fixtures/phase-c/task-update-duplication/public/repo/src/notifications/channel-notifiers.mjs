export function sendEmail(user, message) {
  return { channel: "EMAIL", to: user.email, message };
}

export function sendSlack(user, message) {
  return { channel: "SLACK", to: user.id, message };
}
