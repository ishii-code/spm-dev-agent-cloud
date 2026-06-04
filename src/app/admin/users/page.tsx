// /admin/users: アカウント管理。middleware で ADMIN 保証済だが requireAdmin で二重防御。
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { UsersClient } from "./UsersClient";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const session = await requireAdmin();
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      createdAt: true,
      lastLoginAt: true,
      mustChangePassword: true,
      slackId: true,
    },
  });

  const serialized = users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    mustChangePassword: u.mustChangePassword,
    slackId: u.slackId,
  }));

  return <UsersClient users={serialized} currentUserId={session.userId} />;
}
