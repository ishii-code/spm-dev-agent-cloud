import { SYSTEM_RUNTIMES } from "@/lib/system-registry";

export const runtime = "nodejs";

async function probe(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}`, {
      signal: AbortSignal.timeout(1000),
      cache: "no-store",
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

export async function GET() {
  const results = await Promise.all(
    SYSTEM_RUNTIMES.map(async (sys) => ({
      id: sys.id,
      running: await probe(sys.port),
    })),
  );
  return Response.json(results);
}
