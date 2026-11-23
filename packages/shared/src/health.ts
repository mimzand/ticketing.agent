import { z } from 'zod';

/** What `system.ping` reports: the agent is alive, and which build and protocol it runs. */
export const AgentPingSchema = z.strictObject({
  pid: z.int().positive(),
  version: z.string().min(1).max(64),
  protocolVersion: z.int().positive(),
});
export type AgentPing = z.infer<typeof AgentPingSchema>;

export const AgentReachabilitySchema = z.enum(['connected', 'unavailable']);
export type AgentReachability = z.infer<typeof AgentReachabilitySchema>;

export const OllamaReachabilitySchema = z.enum(['reachable', 'unreachable']);
export type OllamaReachability = z.infer<typeof OllamaReachabilitySchema>;

/**
 * `GET /health` of the HTTP API. Public: carries no token, port, or key.
 * `model` is empty when the agent could not be asked.
 */
export const ApiHealthSchema = z.strictObject({
  ok: z.literal(true),
  service: z.literal('ticket-api'),
  agent: AgentReachabilitySchema,
  ollama: OllamaReachabilitySchema,
  model: z.string().max(128),
});
export type ApiHealth = z.infer<typeof ApiHealthSchema>;

/** What the desktop renderer gets from `window.api.getHealth()`. Never the token or the port. */
export const DesktopHealthSchema = z.discriminatedUnion('agent', [
  z.strictObject({
    agent: z.literal('connected'),
    ping: AgentPingSchema,
    checkedAt: z.iso.datetime(),
  }),
  z.strictObject({
    agent: z.literal('unavailable'),
    reason: z.string().min(1).max(500),
    checkedAt: z.iso.datetime(),
  }),
]);
export type DesktopHealth = z.infer<typeof DesktopHealthSchema>;
