import { NextResponse } from "next/server";
import { getDashboardMetrics } from "@/lib/metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const metrics = await getDashboardMetrics();
    return NextResponse.json(metrics, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch {
    return NextResponse.json({ error: "Metrics are temporarily unavailable" }, { status: 503 });
  }
}
