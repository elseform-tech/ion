import type { AdapterEvent } from "@ion/adapter-kit";
import { EV } from "@ion/schema";

/** A run.started says what memory the session started with ("all", "project" or "none"); other events as they are. */
export function withMemory(e: AdapterEvent, memory: "none" | "project" | undefined): AdapterEvent {
  return e.type === EV.runStarted ? { ...e, data: { ...e.data, memory: memory ?? "all" } } : e;
}

/**
 * The chat's session to resume: on the same agent, and only with the memory it started with (review of #34,
 * 2026-11-23: a chat you stopped remembering resumed a session holding memory's index); else none, a fresh one.
 */
export function resumable(
  s: { harness: string; sessionId: string; memory: string } | null,
  l: { h: { adapter: { id: string } }; memory?: "none" | "project" },
): string | null {
  return s && s.harness === l.h.adapter.id && s.memory === (l.memory ?? "all") ? s.sessionId : null;
}
