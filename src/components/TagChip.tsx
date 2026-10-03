import { Tag } from 'lucide-react';

export function stringToPastelHex(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = value.charCodeAt(index) + ((hash << 5) - hash);
  }

  let color = '#';
  for (let index = 0; index < 3; index += 1) {
    const channel = (hash >> (index * 8)) & 0xff;
    color += Math.floor((channel + 255) / 2).toString(16).padStart(2, '0');
  }
  return color;
}

export function TagChip({ tag }: { tag: string }) {
  return (
    <span className="tag" style={{ backgroundColor: stringToPastelHex(tag), color: '#0a0a0a' }}>
      <Tag aria-hidden="true" />{tag}
    </span>
  );
}
