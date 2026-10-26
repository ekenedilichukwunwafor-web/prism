import { NextResponse } from "next/server";
import { xdr } from "@stellar/stellar-sdk";
import { getTransaction } from "@/lib/horizon";
import { getInvocationReturnValue } from "@/lib/soroban";
import { decodeInvocation, getResourceUsage } from "@/lib/xdr";
import { rateLimitAsync, getClientKey } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

interface Params { params: { hash: string } }

export async function GET(req: Request, { params }: Params) {
  const key = `tx:${getClientKey(req)}`;
  const limitResult = await rateLimitAsync(key, 30, 60_000);
  if (!limitResult.success) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limitResult.retryAfter ?? 60) } }
    );
  }

  let tx;
  try {
    tx = await getTransaction(params.hash);
  } catch {
    return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
  }

  let invocation: ReturnType<typeof decodeInvocation> = null;
  let resources: ReturnType<typeof getResourceUsage> = null;
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(tx.envelopeXdr, "base64");
    invocation = decodeInvocation(envelope);
    resources = getResourceUsage(envelope);
  } catch {
    // Envelope uses a newer XDR type this SDK version cannot decode.
    // Return the Horizon fields with envelope-derived fields set to null (#26).
  }
  const returnValue = invocation ? await getInvocationReturnValue(tx.hash) : null;

  return NextResponse.json({ ...tx, invocation, resources, returnValue });
}
