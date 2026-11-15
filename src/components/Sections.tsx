import Image from 'next/image';
import { ArrowUpRight, Braces, BrainCircuit, GitBranch, Radio, ChartNoAxesCombined, Trophy, Swords, Check, Terminal, ArrowRight } from 'lucide-react';
import { competition, steps, faqs } from '@/config/competition';

function SectionLabel({ number, children }: { number: string; children: React.ReactNode }) {
  return <div className="eyebrow section-label"><span>{number} /</span>{children}</div>;
}

export function About() {
  return <section id="about" className="section container about-section"><SectionLabel number="01">О ХАКАТОНЕ</SectionLabel>
    <div className="about-grid"><div><h2>Шахматы — классика.<br /><span>Твой подход — новый.</span></h2><p className="section-description">DeepMove — хакатон КАИТ №20, где встречаются программирование и шахматы. За две недели ты создашь движок, который будет думать, выбирать и играть самостоятельно.</p><p className="muted">В финале за доску сядут алгоритмы. За каждым из них — твои идеи, эксперименты и решения.</p></div>
    <div className="approach-panel"><div className="panel-top"><Terminal size={16} /><span>ОДНА ЗАДАЧА. РАЗНЫЕ РЕШЕНИЯ.</span><span className="panel-dots">···</span></div>{[{ icon: Braces, title: 'Математика и поиск', text: 'Просчитывай варианты. Находи лучший ход.', code: '01' }, { icon: BrainCircuit, title: 'Нейросети и обучение', text: 'Учи алгоритм видеть больше.', code: '02' }, { icon: GitBranch, title: 'Эвристики и гибриды', text: 'Объединяй подходы. Создавай свой.', code: '03' }].map(({ icon: Icon, title, text, code }) => <div className="approach" key={code}><Icon size={25} strokeWidth={1.4} /><div><h3>{title}</h3><p>{text}</p></div><span>{code}</span></div>)}<div className="code-comment">{'// сильная идея важнее знакомого языка'}</div></div></div>
  </section>;
}

export function Participation() {
  return <section id="participate" className="section container"><SectionLabel number="02">КАК УЧАСТВОВАТЬ</SectionLabel><div className="section-heading"><h2>От первой строки<br />до финальной партии.</h2><p className="muted">Четыре этапа.<br />И множество ходов между ними.</p></div><div className="steps">{steps.map((step, i) => <article className="step" key={step.title}><div className="step-number">0{i + 1}<ArrowRight size={19} /></div><span className="step-tag">{step.tag}</span><h3>{step.title}</h3><p>{step.description}</p></article>)}</div></section>;
}

export function Rules() {
  return <section id="rules" className="section container"><div className="rules-panel"><div><SectionLabel number="03">ПРАВИЛА ИГРЫ</SectionLabel><h2>Свобода в подходе.<br /><span>Честность в коде.</span></h2><p className="muted">Общие условия хакатона. Полный регламент<br className="desktop-break" /> и требования к API появятся перед стартом.</p></div><ul className="rules-list">{['Полностью авторский шахматный движок', 'Любой язык программирования и алгоритмический подход', '14 дней на разработку и эксперименты', '10 минут на движок + 3 секунды за ход'].map(rule => <li key={rule}><Check size={17} />{rule}</li>)}<li className="rule-restriction"><span>×</span> Готовые шахматные движки запрещены</li></ul></div></section>;
}

export function Platform() {
  const features = [{ icon: Swords, title: 'Тренировочные матчи', text: 'Проверяй идеи до решающей партии.' }, { icon: Radio, title: 'Прямые трансляции', text: 'Следи за ходами и развитием игры.' }, { icon: Trophy, title: 'Турнирная таблица', text: 'Наблюдай за борьбой алгоритмов.' }, { icon: ChartNoAxesCombined, title: 'Аналитика движков', text: 'Разбирай партии и улучшай стратегию.' }];
  return <section id="tournament" className="section container"><SectionLabel number="04">БУДУЩАЯ АРЕНА</SectionLabel><div className="section-heading"><h2>Ты пишешь код.<br /><span>Арена делает остальное.</span></h2><p className="muted">Организаторы готовят API,<br />инструменты тестирования и игровую платформу.</p></div><div className="features">{features.map(({ icon: Icon, title, text }) => <article className="feature" key={title}><div className="feature-top"><Icon size={24} strokeWidth={1.4} /><span className="soon">Скоро</span></div><h3>{title}</h3><p>{text}</p></article>)}</div></section>;
}

export function FAQ() {
  return <section id="faq" className="section container faq-section"><div><SectionLabel number="05">FAQ</SectionLabel><h2>Хорошие вопросы.<br /><span>Прямые ответы.</span></h2><p className="muted">Всё, что нужно знать<br />перед первым ходом.</p></div><div className="faq-list">{faqs.map(faq => <details key={faq.question}><summary>{faq.question}<span className="faq-plus" aria-hidden="true">+</span></summary><p>{faq.answer}</p></details>)}</div></section>;
}

export function Registration() {
  return <section id="registration" className="container registration-section"><div className="registration-panel"><Image src="/assets/Deep_Move_Icon_Vector.svg" width={94} height={94} alt="" /><div><div className="eyebrow">СЛЕДУЮЩИЙ ХОД — ЗА ТОБОЙ</div><h2>Большая игра начинается с идеи.</h2><p>Приём заявок откроется скоро. Даты и способ регистрации появятся здесь.</p></div><span className="registration-status"><span /> Регистрация скоро</span></div></section>;
}

export function Footer() {
  return <footer className="container footer"><div className="footer-top"><a href="#home" className="footer-brand"><Image src="/assets/Deep_Move_Icon_Vector.svg" alt="" width={43} height={43} /><span>deepmove<span className="wordmark-dot">.</span></span></a><nav aria-label="Навигация в подвале">{competition.navigation.map(item => <a key={item.href} href={item.href}>{item.label}</a>)}</nav><a href="#home" className="back-top" aria-label="Вернуться наверх"><ArrowUpRight size={20} /></a></div><div className="footer-bottom"><div className="footer-organizer"><Image src="/assets/kait_logo_white.png" alt="КАИТ №20" width={66} height={33} /><span>Организатор хакатона</span></div><span>Контакты организаторов будут опубликованы позже.</span><span>DeepMove · Код. Стратегия. Шахматы.</span></div></footer>;
}
