/** A stable pastel colour for a tag name: the colour a new tag starts with in the tag form. */
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
