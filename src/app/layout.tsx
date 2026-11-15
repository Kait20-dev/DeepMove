import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DeepMove — хакатон по программированию и шахматам | КАИТ №20',
  description: 'Создай собственный шахматный алгоритм за 14 дней и проверь его силу в битве движков. DeepMove — хакатон КАИТ №20.',
  icons: { icon: '/assets/Deep_Move_Icon_Vector.svg' },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body><a className="skip-link" href="#main">Перейти к содержимому</a>{children}</body></html>;
}
