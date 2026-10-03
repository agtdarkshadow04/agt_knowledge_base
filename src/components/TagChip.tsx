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
  const color = stringToPastelHex(tag);
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);

  return (
    <span
      className="tag"
      style={{ color, border: `1px solid ${color}`, backgroundColor: `rgba(${red}, ${green}, ${blue}, 0.1)` }}
    >
      <Tag aria-hidden="true" />{tag}
    </span>
  );
}
