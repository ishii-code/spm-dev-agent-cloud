import { spawn } from "node:child_process";
import { getSystemRuntime } from "@/lib/system-registry";

export const runtime = "nodejs";

async function isUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}`, {
      signal: AbortSignal.timeout(500),
      cache: "no-store",
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

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
    return Response.json({ error: "unknown_system" }, { status: 400 });
  }

  // 既に起動中ならスポーンしない
  if (await isUp(sys.port)) {
    return Response.json({ success: true, alreadyRunning: true });
  }

  let spawnError: string | null = null;
  try {
    const proc = spawn("npm", ["run", "dev"], {
      cwd: sys.dir,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PORT: String(sys.port) },
    });
    proc.on("error", (err) => {
      spawnError = err.message;
    });
    proc.unref();
  } catch (err) {
    return Response.json(
      {
        success: false,
        message: `spawn失敗: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 500 },
    );
  }

  // 最大10秒、1秒間隔で起動確認
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isUp(sys.port)) {
      return Response.json({ success: true });
    }
    if (spawnError) {
      return Response.json(
        { success: false, message: `起動失敗: ${spawnError}` },
        { status: 500 },
      );
    }
  }

  return Response.json(
    { success: false, message: "起動タイムアウト" },
    { status: 504 },
  );
}
