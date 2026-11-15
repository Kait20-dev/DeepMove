import { GameRoom } from '@/features/arena/GameRoom';
export default async function GamePage({ params }: { params: Promise<{ id: string }> }) { return <GameRoom id={(await params).id} />; }
