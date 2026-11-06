/** A magnet's tracker list, display name and query order are not its identity. */
export function normalizeInfoHash(value: string): string {
  if (/^[a-f\d]{40}$/i.test(value)) return value.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(value)) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0;
    let accumulator = 0;
    const bytes: number[] = [];
    for (const character of value.toUpperCase()) {
      accumulator = (accumulator << 5) | alphabet.indexOf(character);
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((accumulator >>> bits) & 255);
      }
    }
    return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("A valid BitTorrent infoHash is required");
}

