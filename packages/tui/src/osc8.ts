/**
 * OSC 8 terminal hyperlinks. Supported by iTerm2, kitty, WezTerm, GNOME
 * Terminal, modern macOS Terminal, etc. Falls back to plain label text in
 * terminals that don't understand the escape (they strip the unknown OSC).
 *
 * Format: ESC ] 8 ; <params> ; <uri> BEL <label> ESC ] 8 ; ; BEL
 */
const ESC = "\u001b";
const BEL = "\u0007";

export function hyperlink(label: string, target: string): string {
  return `${ESC}]8;;${target}${BEL}${label}${ESC}]8;;${BEL}`;
}
