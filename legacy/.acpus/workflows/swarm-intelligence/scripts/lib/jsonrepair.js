// jsonrepair v3.14.0 — inlined from https://github.com/josdejong/jsonrepair
// ISC License — Copyright (c) 2020-2026 Jos de Jong

export class JSONRepairError extends Error {
  constructor(message, position) {
    super(`${message} at position ${position}`);
    this.position = position;
  }
}

const codeSpace = 0x20;
const codeNewline = 0xa;
const codeTab = 0x9;
const codeReturn = 0xd;
const codeNonBreakingSpace = 0x00a0;
const codeMongolianVowelSeparator = 0x180e;
const codeEnQuad = 0x2000;
const codeZeroWidthSpace = 0x200b;
const codeNarrowNoBreakSpace = 0x202f;
const codeMediumMathematicalSpace = 0x205f;
const codeIdeographicSpace = 0x3000;
const codeZeroWidthNoBreakSpace = 0xfeff;

function isHex(char) { return /^[0-9A-Fa-f]$/.test(char); }
function isDigit(char) { return char >= "0" && char <= "9"; }
function isValidStringCharacter(char) { return char >= " "; }
function isDelimiter(char) { return ",:[]/{}()\n+".includes(char); }
function isFunctionNameCharStart(char) { return char >= "a" && char <= "z" || char >= "A" && char <= "Z" || char === "_" || char === "$"; }
function isFunctionNameChar(char) { return char >= "a" && char <= "z" || char >= "A" && char <= "Z" || char === "_" || char === "$" || char >= "0" && char <= "9"; }
const regexUrlStart = /^(http|https|ftp|mailto|file|data|irc):\/\/$/;
const regexUrlChar = /^[A-Za-z0-9-._~:/?#@!$&'()*+;=]$/;
function isUnquotedStringDelimiter(char) { return ",[]/{}\n+".includes(char); }
const regexStartOfValue = /^[[{\w-]$/;
function isStartOfValue(char) { return isQuote(char) || regexStartOfValue.test(char); }
function isControlCharacter(char) { return char === "\n" || char === "\r" || char === "\t" || char === "\b" || char === "\f"; }
function isWhitespace(text, index) { const code = text.charCodeAt(index); return code === codeSpace || code === codeNewline || code === codeTab || code === codeReturn; }
function isWhitespaceExceptNewline(text, index) { const code = text.charCodeAt(index); return code === codeSpace || code === codeTab || code === codeReturn; }
function isSpecialWhitespace(text, index) { const code = text.charCodeAt(index); return code === codeNonBreakingSpace || code === codeMongolianVowelSeparator || code >= codeEnQuad && code <= codeZeroWidthSpace || code === codeNarrowNoBreakSpace || code === codeMediumMathematicalSpace || code === codeIdeographicSpace || code === codeZeroWidthNoBreakSpace; }
function isQuote(char) { return isDoubleQuoteLike(char) || isSingleQuoteLike(char); }
function isDoubleQuoteLike(char) { return char === '"' || char === "“" || char === "”"; }
function isDoubleQuote(char) { return char === '"'; }
function isSingleQuoteLike(char) { return char === "'" || char === "‘" || char === "’" || char === "`" || char === "´"; }
function isSingleQuote(char) { return char === "'"; }
function stripLastOccurrence(text, textToStrip, stripRemainingText = false) { const index = text.lastIndexOf(textToStrip); return index !== -1 ? text.substring(0, index) + (stripRemainingText ? "" : text.substring(index + 1)) : text; }
function insertBeforeLastWhitespace(text, textToInsert) { let index = text.length; if (!isWhitespace(text, index - 1)) return text + textToInsert; while (isWhitespace(text, index - 1)) index--; return text.substring(0, index) + textToInsert + text.substring(index); }
function removeAtIndex(text, start, count) { return text.substring(0, start) + text.substring(start + count); }
function endsWithCommaOrNewline(text) { return /[,\n][ \t\r]*$/.test(text); }

const controlCharacters = { "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
const escapeCharacters = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

export function jsonrepair(text) {
  let i = 0;
  let output = "";

  parseMarkdownCodeBlock(["```", "[```", "{```"]);
  const processed = parseValue();
  if (!processed) throwUnexpectedEnd();
  parseMarkdownCodeBlock(["```", "```]", "```}"]);
  const processedComma = parseCharacter(",");
  if (processedComma) parseWhitespaceAndSkipComments();
  if (isStartOfValue(text[i]) && endsWithCommaOrNewline(output)) {
    if (!processedComma) output = insertBeforeLastWhitespace(output, ",");
    parseNewlineDelimitedJSON();
  } else if (processedComma) {
    output = stripLastOccurrence(output, ",");
  }
  while (text[i] === "}" || text[i] === "]") { i++; parseWhitespaceAndSkipComments(); }
  if (i >= text.length) return output;
  throwUnexpectedCharacter();

  function parseValue() {
    parseWhitespaceAndSkipComments();
    const processed = parseObject() || parseArray() || parseString() || parseNumber() || parseKeywords() || parseUnquotedString(false) || parseRegex();
    parseWhitespaceAndSkipComments();
    return processed;
  }
  function parseWhitespaceAndSkipComments(skipNewline = true) {
    const start = i;
    let changed = parseWhitespace(skipNewline);
    do { changed = parseComment(); if (changed) changed = parseWhitespace(skipNewline); } while (changed);
    return i > start;
  }
  function parseWhitespace(skipNewline) {
    const _isWhiteSpace = skipNewline ? isWhitespace : isWhitespaceExceptNewline;
    let whitespace = "";
    while (true) {
      if (_isWhiteSpace(text, i)) { whitespace += text[i]; i++; }
      else if (isSpecialWhitespace(text, i)) { whitespace += " "; i++; }
      else break;
    }
    if (whitespace.length > 0) { output += whitespace; return true; }
    return false;
  }
  function parseComment() {
    if (text[i] === "/" && text[i + 1] === "*") { while (i < text.length && !atEndOfBlockComment(text, i)) i++; i += 2; return true; }
    if (text[i] === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; return true; }
    return false;
  }
  function parseMarkdownCodeBlock(blocks) {
    if (skipMarkdownCodeBlock(blocks)) {
      if (isFunctionNameCharStart(text[i])) { while (i < text.length && isFunctionNameChar(text[i])) i++; }
      parseWhitespaceAndSkipComments();
      return true;
    }
    return false;
  }
  function skipMarkdownCodeBlock(blocks) {
    parseWhitespace(true);
    for (const block of blocks) { const end = i + block.length; if (text.slice(i, end) === block) { i = end; return true; } }
    return false;
  }
  function parseCharacter(char) { if (text[i] === char) { output += text[i]; i++; return true; } return false; }
  function skipCharacter(char) { if (text[i] === char) { i++; return true; } return false; }
  function skipEscapeCharacter() { return skipCharacter("\\"); }
  function skipEllipsis() {
    parseWhitespaceAndSkipComments();
    if (text[i] === "." && text[i + 1] === "." && text[i + 2] === ".") { i += 3; parseWhitespaceAndSkipComments(); skipCharacter(","); return true; }
    return false;
  }
  function parseObject() {
    if (text[i] === "{") {
      output += "{"; i++; parseWhitespaceAndSkipComments();
      if (skipCharacter(",")) parseWhitespaceAndSkipComments();
      let initial = true;
      while (i < text.length && text[i] !== "}") {
        let processedComma;
        if (!initial) { processedComma = parseCharacter(","); if (!processedComma) output = insertBeforeLastWhitespace(output, ","); parseWhitespaceAndSkipComments(); }
        else { processedComma = true; initial = false; }
        skipEllipsis();
        const processedKey = parseString() || parseUnquotedString(true);
        if (!processedKey) { if (text[i] === "}" || text[i] === "{" || text[i] === "]" || text[i] === "[" || text[i] === undefined) { output = stripLastOccurrence(output, ","); } else { throwObjectKeyExpected(); } break; }
        parseWhitespaceAndSkipComments();
        const processedColon = parseCharacter(":");
        const truncatedText = i >= text.length;
        if (!processedColon) { if (isStartOfValue(text[i]) || truncatedText) { output = insertBeforeLastWhitespace(output, ":"); } else { throwColonExpected(); } }
        const processedValue = parseValue();
        if (!processedValue) { if (processedColon || truncatedText) { output += "null"; } else { throwColonExpected(); } }
      }
      if (text[i] === "}") { output += "}"; i++; } else { output = insertBeforeLastWhitespace(output, "}"); }
      return true;
    }
    return false;
  }
  function parseArray() {
    if (text[i] === "[") {
      output += "["; i++; parseWhitespaceAndSkipComments();
      if (skipCharacter(",")) parseWhitespaceAndSkipComments();
      let initial = true;
      while (i < text.length && text[i] !== "]") {
        if (!initial) { const processedComma = parseCharacter(","); if (!processedComma) output = insertBeforeLastWhitespace(output, ","); }
        else { initial = false; }
        skipEllipsis();
        const processedValue = parseValue();
        if (!processedValue) { output = stripLastOccurrence(output, ","); break; }
      }
      if (text[i] === "]") { output += "]"; i++; } else { output = insertBeforeLastWhitespace(output, "]"); }
      return true;
    }
    return false;
  }
  function parseNewlineDelimitedJSON() {
    let initial = true;
    let processedValue = true;
    while (processedValue) {
      if (!initial) { const processedComma = parseCharacter(","); if (!processedComma) output = insertBeforeLastWhitespace(output, ","); }
      else { initial = false; }
      processedValue = parseValue();
    }
    if (!processedValue) output = stripLastOccurrence(output, ",");
    output = `[\n${output}\n]`;
  }
  function parseString(stopAtDelimiter = false, stopAtIndex = -1) {
    let skipEscapeChars = text[i] === "\\";
    if (skipEscapeChars) { i++; skipEscapeChars = true; }
    if (isQuote(text[i])) {
      const isEndQuote = isDoubleQuote(text[i]) ? isDoubleQuote : isSingleQuote(text[i]) ? isSingleQuote : isSingleQuoteLike(text[i]) ? isSingleQuoteLike : isDoubleQuoteLike;
      const iBefore = i;
      const oBefore = output.length;
      let str = '"';
      i++;
      while (true) {
        if (i >= text.length) {
          const iPrev = prevNonWhitespaceIndex(i - 1);
          if (!stopAtDelimiter && isDelimiter(text.charAt(iPrev))) { i = iBefore; output = output.substring(0, oBefore); return parseString(true); }
          str = insertBeforeLastWhitespace(str, '"'); output += str; return true;
        }
        if (i === stopAtIndex) { str = insertBeforeLastWhitespace(str, '"'); output += str; return true; }
        if (isEndQuote(text[i])) {
          const iQuote = i; const oQuote = str.length; str += '"'; i++; output += str; parseWhitespaceAndSkipComments(false);
          if (stopAtDelimiter || i >= text.length || isDelimiter(text[i]) || isQuote(text[i]) || isDigit(text[i])) { parseConcatenatedString(); return true; }
          const iPrevChar = prevNonWhitespaceIndex(iQuote - 1); const prevChar = text.charAt(iPrevChar);
          if (prevChar === ",") { i = iBefore; output = output.substring(0, oBefore); return parseString(false, iPrevChar); }
          if (isDelimiter(prevChar)) { i = iBefore; output = output.substring(0, oBefore); return parseString(true); }
          output = output.substring(0, oBefore); i = iQuote + 1; str = `${str.substring(0, oQuote)}\\${str.substring(oQuote)}`;
        } else if (stopAtDelimiter && isUnquotedStringDelimiter(text[i])) {
          if (text[i - 1] === ":" && regexUrlStart.test(text.substring(iBefore + 1, i + 2))) { while (i < text.length && regexUrlChar.test(text[i])) { str += text[i]; i++; } }
          str = insertBeforeLastWhitespace(str, '"'); output += str; parseConcatenatedString(); return true;
        } else if (text[i] === "\\") {
          const char = text.charAt(i + 1); const escapeChar = escapeCharacters[char];
          if (escapeChar !== undefined) { str += text.slice(i, i + 2); i += 2; }
          else if (char === "u") { let j = 2; while (j < 6 && isHex(text[i + j])) j++; if (j === 6) { str += text.slice(i, i + 6); i += 6; } else if (i + j >= text.length) { i = text.length; } else { throwInvalidUnicodeCharacter(); } }
          else if (char === "\n") { str += "\\n"; i += 2; }
          else { str += char; i += 2; }
        } else {
          const char = text.charAt(i);
          if (char === '"' && text[i - 1] !== "\\") { str += `\\${char}`; i++; }
          else if (isControlCharacter(char)) { str += controlCharacters[char]; i++; }
          else { if (!isValidStringCharacter(char)) throwInvalidCharacter(char); str += char; i++; }
        }
        if (skipEscapeChars) skipEscapeCharacter();
      }
    }
    return false;
  }
  function parseConcatenatedString() {
    let processed = false; parseWhitespaceAndSkipComments();
    while (text[i] === "+") {
      processed = true; i++; parseWhitespaceAndSkipComments();
      output = stripLastOccurrence(output, '"', true); const start = output.length; const parsedStr = parseString();
      if (parsedStr) { output = removeAtIndex(output, start, 1); } else { output = insertBeforeLastWhitespace(output, '"'); }
    }
    return processed;
  }
  function parseNumber() {
    const start = i;
    if (text[i] === "-") { i++; if (atEndOfNumber()) { repairNumberEndingWithNumericSymbol(start); return true; } if (!isDigit(text[i])) { i = start; return false; } }
    while (isDigit(text[i])) i++;
    if (text[i] === ".") { i++; if (atEndOfNumber()) { repairNumberEndingWithNumericSymbol(start); return true; } if (!isDigit(text[i])) { i = start; return false; } while (isDigit(text[i])) i++; }
    if (text[i] === "e" || text[i] === "E") { i++; if (text[i] === "-" || text[i] === "+") i++; if (atEndOfNumber()) { repairNumberEndingWithNumericSymbol(start); return true; } if (!isDigit(text[i])) { i = start; return false; } while (isDigit(text[i])) i++; }
    if (!atEndOfNumber()) { i = start; return false; }
    if (i > start) { const num = text.slice(start, i); const hasInvalidLeadingZero = /^0\d/.test(num); output += hasInvalidLeadingZero ? `"${num}"` : num; return true; }
    return false;
  }
  function parseKeywords() {
    return parseKeyword("true", "true") || parseKeyword("false", "false") || parseKeyword("null", "null") ||
      parseKeyword("True", "true") || parseKeyword("False", "false") || parseKeyword("None", "null");
  }
  function parseKeyword(name, value) { if (text.slice(i, i + name.length) === name) { output += value; i += name.length; return true; } return false; }
  function parseUnquotedString(isKey) {
    const start = i;
    if (isFunctionNameCharStart(text[i])) {
      while (i < text.length && isFunctionNameChar(text[i])) i++;
      let j = i; while (isWhitespace(text, j)) j++;
      if (text[j] === "(") { i = j + 1; parseValue(); if (text[i] === ")") { i++; if (text[i] === ";") i++; } return true; }
    }
    while (i < text.length && !isUnquotedStringDelimiter(text[i]) && !isQuote(text[i]) && (!isKey || text[i] !== ":")) i++;
    if (text[i - 1] === ":" && regexUrlStart.test(text.substring(start, i + 2))) { while (i < text.length && regexUrlChar.test(text[i])) i++; }
    if (i > start) {
      while (isWhitespace(text, i - 1) && i > 0) i--;
      const symbol = text.slice(start, i); output += symbol === "undefined" ? "null" : JSON.stringify(symbol);
      if (text[i] === '"') i++;
      return true;
    }
  }
  function parseRegex() {
    if (text[i] === "/") { const start = i; i++; while (i < text.length && (text[i] !== "/" || text[i - 1] === "\\")) i++; i++; output += JSON.stringify(text.substring(start, i)); return true; }
  }
  function prevNonWhitespaceIndex(start) { let prev = start; while (prev > 0 && isWhitespace(text, prev)) prev--; return prev; }
  function atEndOfNumber() { return i >= text.length || isDelimiter(text[i]) || isWhitespace(text, i); }
  function repairNumberEndingWithNumericSymbol(start) { output += `${text.slice(start, i)}0`; }
  function throwInvalidCharacter(char) { throw new JSONRepairError(`Invalid character ${JSON.stringify(char)}`, i); }
  function throwUnexpectedCharacter() { throw new JSONRepairError(`Unexpected character ${JSON.stringify(text[i])}`, i); }
  function throwUnexpectedEnd() { throw new JSONRepairError("Unexpected end of json string", text.length); }
  function throwObjectKeyExpected() { throw new JSONRepairError("Object key expected", i); }
  function throwColonExpected() { throw new JSONRepairError("Colon expected", i); }
  function throwInvalidUnicodeCharacter() { throw new JSONRepairError(`Invalid unicode character "${text.slice(i, i + 6)}"`, i); }
}

function atEndOfBlockComment(text, i) { return text[i] === "*" && text[i + 1] === "/"; }
