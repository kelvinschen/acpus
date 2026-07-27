export function utf8Head(value: string, maxBytes: number): string {
  let end = 0;
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character);
    if (bytes + next > maxBytes) break;
    bytes += next;
    end += character.length;
  }
  return value.slice(0, end);
}

export function utf8Tail(value: string, maxBytes: number): string {
  let start = value.length;
  let bytes = 0;
  while (start > 0) {
    let characterStart = start - 1;
    const code = value.charCodeAt(characterStart);
    if (code >= 0xdc00 && code <= 0xdfff && characterStart > 0) characterStart -= 1;
    const character = value.slice(characterStart, start);
    const next = Buffer.byteLength(character);
    if (bytes + next > maxBytes) break;
    bytes += next;
    start = characterStart;
  }
  return value.slice(start);
}
