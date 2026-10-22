import { NextResponse } from "next/server";
import { getContractEventsPage } from "@/lib/soroban";
import { parsePageRequest } from "@/lib/history-cursor";
import { EVENT_PAGE_SIZE } from "@/lib/contract-lists";
import { rateLimitRequest } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

interface Params { params: { id: string } }

export async function GET(req: Request, { params }: Params) {
  const limited = rateLimitRequest(req, { scope: "contract-events" });
  if (limited) return limited;

  const request = parsePageRequest(new URL(req.url), EVENT_PAGE_SIZE);
  if (!request) return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });

  const { items, nextCursor, error } = await getContractEventsPage(params.id, request);
  if (error) {
    return NextResponse.json({ events: [], nextCursor: null, error }, { status: 502 });
  }
  return NextResponse.json({ events: items, nextCursor, error: null });
}
