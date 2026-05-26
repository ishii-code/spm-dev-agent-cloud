import { promises as fs } from "node:fs";
import { prisma } from "@/lib/prisma";
import { writeVaultFile } from "@/lib/obsidian";

export const runtime = "nodejs";

const MAX_CONTENT = 200_000;

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  const obj = body as Record<string, unknown>;
  const content = obj.content;
  if (typeof content !== "string" || content.length === 0 || content.length > MAX_CONTENT) {
    return Response.json({ error: "invalid_content" }, { status: 400 });
  }

  const existing = await prisma.document.findUnique({ where: { id } });
  if (!existing) {
    return Response.json({ error: "document_not_found" }, { status: 404 });
  }

  if (existing.obsidianPath) {
    try {
      // 既存パスがVAULT配下なら相対化、それ以外は絶対パスとして書き戻し
      const vault = process.env.OBSIDIAN_VAULT_PATH ?? "";
      if (vault && existing.obsidianPath.startsWith(vault)) {
        const relative = existing.obsidianPath.slice(vault.length).replace(/^\/+/, "");
        await writeVaultFile(relative, content);
      } else {
        await fs.writeFile(existing.obsidianPath, content, "utf-8");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      return Response.json({ error: `obsidian_write_failed: ${msg}` }, { status: 500 });
    }
  }

  const updated = await prisma.document.update({
    where: { id },
    data: { content },
  });

  return Response.json({ document: updated });
}

export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const existing = await prisma.document.findUnique({ where: { id } });
  if (!existing) {
    return Response.json({ error: "document_not_found" }, { status: 404 });
  }

  if (existing.obsidianPath) {
    await fs.unlink(existing.obsidianPath).catch(() => {});
  }

  await prisma.document.delete({ where: { id } });
  return new Response(null, { status: 204 });
}
