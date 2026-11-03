import { getLogService } from "@/lib/logs/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return getLogService().handleRead(request);
}

// Without this, Next runs GET for HEAD requests (which would start docker logs).
export const HEAD = GET;
