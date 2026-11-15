import { GameRoom } from '@/features/arena/GameRoom';
export default async function GamePage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <GameRoom key={id} id={id} />; }
