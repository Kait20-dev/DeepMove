import { ArrowDown, ArrowUpRight, Code2, Timer, CalendarDays, Swords, MoveUpRight } from 'lucide-react';
import { competition } from '@/config/competition';

const highlights = [
  { icon: CalendarDays, value: `${competition.developmentDays} дней`, label: 'от идеи до движка' },
  { icon: Code2, value: 'Твой алгоритм', label: 'полностью авторский код' },
  { icon: Timer, value: competition.timeControl, label: 'контроль времени' },
  { icon: Swords, value: 'Битва движков', label: 'автоматический турнир' },
];

export function Hero() {
  return <section className="hero container" aria-labelledby="hero-title">
    <div className="hero-content"><div className="eyebrow hero-eyebrow"><span className="tiny-square" /> ХАКАТОН ПО ПРОГРАММИРОВАНИЮ И ШАХМАТАМ</div>
      <h1 id="hero-title">DeepMove.<br />Твой код.<br /><span>Твой следующий ход.</span></h1>
      <p className="hero-description">Создай собственный шахматный алгоритм.<br className="desktop-break" /> Проверь его силу в битве движков.</p>
      <div className="hero-actions"><a href="/arena" className="button">Перейти на арену <ArrowUpRight size={19} /></a><a href="#rules" className="button button-outline">Узнать правила <MoveUpRight size={17} /></a></div>
      <div className="hero-note"><span /> Любой язык. Твой подход. Одна доска.</div>
    </div>
    <div className="board-caption"><span className="live-dot" /><span>КОД СТАНОВИТСЯ СТРАТЕГИЕЙ</span><span className="caption-line" /><span>8 × 8</span></div>
    <div className="hero-bottom"><a href="#about" className="scroll-link"><ArrowDown size={16} /> Открой игру по-новому</a><span className="hero-edition">DEEPMOVE / КАИТ №20</span></div>
    <div className="highlights">{highlights.map(({ icon: Icon, value, label }) => <div className="highlight" key={label}><Icon size={23} strokeWidth={1.4} /><div><strong>{value}</strong><span>{label}</span></div></div>)}</div>
  </section>;
}
