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

/**
 * How the desktop reached the agent: `spawned` (Electron main started it as a utility
 * process) or `attached` (an agent from `yarn agent:dev` / `yarn api:up` was already running).
 */
export const AgentModeSchema = z.enum(['spawned', 'attached']);
export type AgentMode = z.infer<typeof AgentModeSchema>;

/** What the desktop renderer gets from `window.api.getHealth()`. Never the token or the port. */
export const DesktopHealthSchema = z.discriminatedUnion('agent', [
  z.strictObject({
    agent: z.literal('connected'),
    ping: AgentPingSchema,
    mode: AgentModeSchema.nullable(),
    checkedAt: z.iso.datetime(),
  }),
  z.strictObject({
    agent: z.literal('unavailable'),
    reason: z.string().min(1).max(500),
    /** The app's agent stopped unexpectedly and is being restarted. */
    reconnecting: z.boolean(),
    checkedAt: z.iso.datetime(),
  }),
]);
export type DesktopHealth = z.infer<typeof DesktopHealthSchema>;

/** Pushed by Electron main when the supervised agent changes state (so "Reconnecting…" shows at once). */
export const AgentStatusEventSchema = z.strictObject({
  state: z.enum(['idle', 'attached', 'starting', 'running', 'reconnecting', 'failed', 'stopped']),
  mode: AgentModeSchema.nullable(),
  reconnecting: z.boolean(),
});
export type AgentStatusEvent = z.infer<typeof AgentStatusEventSchema>;
