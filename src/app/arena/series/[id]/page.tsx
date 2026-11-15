import { SeriesRoom } from '@/features/arena/Cups';
export default async function SeriesPage({ params }: { params: Promise<{ id: string }> }) {
  return <SeriesRoom id={(await params).id} />;
}
