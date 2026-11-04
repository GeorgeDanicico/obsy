import { NextResponse, type NextRequest } from "next/server";
import { restartApp } from "@/lib/metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  // A custom header forces a CORS preflight, so other sites cannot trigger restarts
  // with a plain cross-origin form POST.
  if (request.headers.get("x-obsy-action") !== "restart") {
    return NextResponse.json({ error: "Missing restart confirmation header" }, { status: 400 });
  }

  const { id } = await context.params;
  const result = await restartApp(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json(
    { restarted: result.app.id, container: result.app.container, at: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
