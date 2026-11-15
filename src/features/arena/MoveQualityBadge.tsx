import { BookOpen, Star, ThumbsUp } from 'lucide-react';
import { qualityNames } from './review-presentation';
import type { MoveQuality } from './types';

export function MoveQualityBadge({ quality }: { quality: MoveQuality }) {
  return <span className={`move-quality-badge ${quality}`} data-quality={quality} role="img" aria-label={qualityNames[quality]} title={quality === 'brilliant-candidate' ? 'Кандидат на бриллиантовый ход — требует проверки' : qualityNames[quality]}>
    {quality === 'best' ? <Star size={13} fill="currentColor" /> : quality === 'good' ? <ThumbsUp size={13} fill="currentColor" /> : quality === 'book' ? <BookOpen size={13} fill="currentColor" /> : quality === 'great' ? '!' : quality === 'brilliant' || quality === 'brilliant-candidate' ? '!!' : quality === 'inaccuracy' || quality === 'mistake' ? '?' : '??'}
  </span>;
}
