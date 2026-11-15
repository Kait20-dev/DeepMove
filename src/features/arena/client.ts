export async function api<T>(path: string, input?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/arena${path}`, {
    method: input ? 'POST' : 'GET', cache: 'no-store', signal,
    headers: input ? { 'Content-Type': 'application/json' } : undefined,
    body: input ? JSON.stringify(input) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ошибка запроса');
  return data as T;
}
export const statusLabel = { waiting: 'Ожидание', playing: 'Идёт игра', finished: 'Завершена' };
export const reasonLabel: Record<string, string> = { timeout: 'Время вышло', checkmate: 'Мат', stalemate: 'Пат', repetition: 'Повторение позиции', insufficient_material: 'Недостаточно материала', fifty_moves: 'Правило 50 ходов', resignation: 'Игрок сдался', cancelled: 'Отменена до старта' };
export const pieceGlyphs: Record<string, string> = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
export const pieceNames: Record<string, string> = { p: 'пешка', n: 'конь', b: 'слон', r: 'ладья', q: 'ферзь', k: 'король' };
