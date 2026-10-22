"use client";

import { useEffect, useState } from "react";
import EventLog from "./EventLog";
import SectionHeader from "./SectionHeader";
import type { ContractEvent, ContractEventSpec } from "@/types";

interface Props {
  contractId: string;
  initialEvents: ContractEvent[];
  initialNextCursor: string | null;
  /** Set when the initial server-side lookup failed; distinct from an empty result. */
  initialError?: string | null;
  /** Page size the list is fetched with, used to tell when the RPC fallback is capped. */
  limit: number;
  /** True when no indexer is configured, so the events come from the RPC node. */
  rpcFallback: boolean;
  /** Event declarations from the contract spec, used to name and label events. */
  specs?: ContractEventSpec[];
  title: string;
  intervalMs?: number;
}

export default function LiveEventLog({
  contractId,
  initialEvents,
  initialNextCursor,
  initialError = null,
  limit,
  rpcFallback,
  specs,
  title,
  intervalMs = 15_000,
}: Props) {
  const [events, setEvents] = useState(initialEvents);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [error, setError] = useState<string | null>(initialError);

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/contract/${contractId}/events`);
        const data = await res.json();
        if (!res.ok || data.error) {
          setError(data.error ?? "The RPC node rejected the request.");
          return;
        }
        setEvents(data.events);
        setNextCursor(data.nextCursor ?? null);
        setError(null);
      } catch {
        setError("The events API could not be reached.");
      }
    }, intervalMs);
    return () => clearInterval(id);
  }, [contractId, intervalMs]);

  return (
    <>
      <SectionHeader
        title={title}
        count={events.length}
        cap={nextCursor !== null || rpcFallback ? limit : undefined}
        live
      />
      <EventLog events={events} specs={specs} error={error} />
    </>
  );
}
