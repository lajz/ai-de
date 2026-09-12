import '../../../admin.css';

import { AdminNav } from '../../../../components/admin/admin-nav';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="admin">
      <AdminNav engagementId={id} />
      {children}
    </main>
  );
}
