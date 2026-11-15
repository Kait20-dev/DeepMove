import { PublicPlayer } from '@/features/arena/PlayerProfile';
export default async function PlayerPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return <PublicPlayer handle={handle} />;
}
