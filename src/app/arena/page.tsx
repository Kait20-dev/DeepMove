import { Dashboard } from '@/features/arena/Dashboard';
export default async function ArenaPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  return <Dashboard initialTab={(await searchParams).tab} />;
}
