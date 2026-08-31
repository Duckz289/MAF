import { makeAccount } from "./account-record.mjs";
import { nextId } from "../util/ids.mjs";

const accounts = new Map();

export function registerAccount(name, email) {
  const account = makeAccount(nextId("account"), name, email);
  accounts.set(account.id, account);
  return account;
}

export function requireAccount(account) {
  if (!account || typeof account.id !== "string") throw new TypeError("an account is required");
  return account;
}
