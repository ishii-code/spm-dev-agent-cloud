import { spawn } from "node:child_process";
import { getSystemRuntime } from "@/lib/system-registry";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const systemId = (body as { systemId?: unknown })?.systemId;
  if (typeof systemId !== "string" || !systemId) {
    return Response.json({ error: "systemId_required" }, { status: 400 });
  }

  const sys = getSystemRuntime(systemId);
  if (!sys) {
    return Response.json({ error: "unknown_system" }, { status: 404 });
  }

  try {
    const proc = spawn("code", [sys.dir], {
      detached: true,
      stdio: "ignore",
    });
    proc.on("error", () => {
      // 親プロセスの error イベントを listen して握りつぶす（子は detached/unref で残り続けるが
      // code が無い等の spawn error はここで来る）
    });
    proc.unref();
  } catch (err) {
    return Response.json(
      {
        success: false,
        message: `VS Code起動失敗: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 500 },
    );
  }

  return Response.json({ success: true });
}
