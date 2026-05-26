export function checkAdminAuth(request: Request): boolean {
  const token = request.headers.get('x-admin-token')
  return token === process.env.ADMIN_PASSWORD
}
