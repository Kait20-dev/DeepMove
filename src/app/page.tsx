import { Header } from '@/components/Header';
import { Hero } from '@/components/Hero';
import { About, Participation, Rules, Platform, FAQ, Registration, Footer } from '@/components/Sections';
import { ChessBackground } from '@/features/chess-background/ChessBackground';

export default function Home() {
  return <div id="home"><ChessBackground /><Header /><main id="main"><Hero /><div className="page-sections"><About /><Participation /><Rules /><Platform /><FAQ /><Registration /></div></main><Footer /></div>;
}
