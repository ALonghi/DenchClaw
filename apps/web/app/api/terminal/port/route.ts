import { NextResponse } from "next/server";
import { getTerminalPort, getTerminalAuthToken } from "@/lib/terminal-server";

export const dynamic = "force-dynamic";

export function GET() {
  const port = getTerminalPort();
  const proxy = process.env.DENCHCLAW_DAEMONLESS === "1";
  const token = getTerminalAuthToken();
  return NextResponse.json(
    { port, proxy, token },
    {
      headers: {
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
      },
    },
  );
}
