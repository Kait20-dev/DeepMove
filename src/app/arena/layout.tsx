import type { Metadata } from 'next';
import { Header } from '@/components/Header';
import './arena.css';
import './game-room.css';
import './community.css';
export const metadata: Metadata = { title: 'Игровая арена — DeepMove', robots: { index: false, follow: false } };
export default function ArenaLayout({ children }: { children: React.ReactNode }) {
  return <><Header /><main id="main" className="arena-app">{children}</main><footer className="arena-footer container">DEEPMOVE / ИГРОВАЯ АРЕНА <span>Собственный код. Честная игра.</span></footer></>;
}
