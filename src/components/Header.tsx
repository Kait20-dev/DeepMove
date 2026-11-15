'use client';

import Image from 'next/image';
import { Menu, X, ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import { competition } from '@/config/competition';

export function Header() {
  const [open, setOpen] = useState(false);
  return <header className="site-header"><div className="header-inner container">
    <a href="#home" className="college-logo" aria-label="КАИТ №20 — на главную"><Image src="/assets/kait_logo_white.png" alt="КАИТ №20" width={108} height={53} priority /></a>
    <span className="header-divider" />
    <a href="#home" className="deepmove-logo" aria-label="DeepMove — на главную"><Image src="/assets/Deep_Move_Logo_Transparent_4K.png" alt="DeepMove" width={150} height={45} priority /></a>
    <nav className="desktop-nav" aria-label="Основная навигация">{competition.navigation.map(item => <a key={item.href} href={item.href}>{item.label}</a>)}</nav>
    <a className="button button-small header-register" href="#registration">Регистрация <ArrowUpRight size={15} /></a>
    <button className="menu-toggle" aria-expanded={open} aria-controls="mobile-navigation" aria-label={open ? 'Закрыть меню' : 'Открыть меню'} onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}</button>
  </div>{open && <nav id="mobile-navigation" className="mobile-nav" aria-label="Мобильная навигация">{competition.navigation.map(item => <a key={item.href} href={item.href} onClick={() => setOpen(false)}>{item.label}</a>)}<a href="#registration" onClick={() => setOpen(false)}>Регистрация ↗</a></nav>}</header>;
}
