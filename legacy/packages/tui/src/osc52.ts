const ESC = "\u001b";
const BEL = "\u0007";

/** Copy text to the terminal clipboard through OSC 52. */
export function copyToClipboard(text: string): void {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  process.stdout.write(`${ESC}]52;c;${encoded}${BEL}`);
}
