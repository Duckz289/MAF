import { makeAgent } from "./agent-record.mjs";
import { nextId } from "../util/ids.mjs";

const agents = new Map();

export function registerAgent(name, email, channel = "mail") {
  const agent = makeAgent(nextId("agent"), name, email, channel);
  agents.set(agent.id, agent);
  return agent;
}

export function requireAgent(agent) {
  if (!agent || typeof agent.email !== "string") throw new TypeError("an agent is required");
  return agent;
}

export function allAgents() {
  return [...agents.values()];
}
