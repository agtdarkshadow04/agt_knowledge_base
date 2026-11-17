import type { CanonicalTag } from '../lib/api';
import { TagIcon } from './Icons';

export { stringToPastelHex } from '../lib/tags';

export function TagChip({ tag }: { tag: CanonicalTag }) {
  const color = tag.color;
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);

  return (
    <span
      className="tag"
      style={{ color, border: `1px solid ${color}`, backgroundColor: `rgba(${red}, ${green}, ${blue}, 0.1)` }}
    >
      <TagIcon aria-hidden="true" />{tag.name}
    </span>
  );
}
