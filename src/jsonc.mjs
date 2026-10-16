// Copied unchanged from claude-settings-doctor (src/jsonc.mjs, MIT, the same author), by way of claude-automode-doctor. Here it gives the
// sandbox settings a line number for the key they are about.
// A JSON reader that knows where everything is, and that tolerates what people write when they think a
// settings file takes comments: // and /* */ comments and trailing commas. It never throws on bad input.
//
// parseJsonc(text) gives
//   ok              true when the text is JSON plus comments and trailing commas, nothing else
//   error           the first thing that is not even that: { message, offset }
//   root            the tree (see below), null when there is an error
//   comments        every comment, in order: { kind: "line" | "block", start, end }
//   trailingCommas  the offset of each comma that has nothing after it but a closing } or ]
//   duplicates      keys written twice in one object: { key, start, firstStart, path }
//   bom             whether the text started with a byte-order mark (offsets count it)
//
// A node is { type, start, end } (end is exclusive) and one of
//   object  members: [{ key, keyRaw, keyStart, start, end, value, comma, leading, trailing }], dangling
//   array   items: nodes that also carry comma, leading and trailing, and dangling
//   string, number, literal  raw (the source text) and value
// comma is the offset of the comma after the element, or null. leading is the comments before the element
// that belong to it; trailing is the comments on the element's own line, after it. dangling holds comments
// that sit after the last element (or are all there is inside the brackets).
//
// This file only reads. src/jsonedit.mjs edits by text; src/build.mjs writes plain JSON from a tree.

const MAX_DEPTH = 500;

/** Sets `key` on `obj` even when it is "__proto__", which a plain assignment would turn into a prototype. */
export function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  return obj;
}

/** The JavaScript value of a node, as JSON.parse would make it (the last one of a repeated key wins). */
export function toValue(node) {
  switch (node.type) {
    case "object": {
      const out = {};
      for (const m of node.members) setOwn(out, m.key, toValue(m.value));
      return out;
    }
    case "array": return node.items.map(toValue);
    default: return node.value;
  }
}

/** The member of an object node with this key (the last one), or null. */
export function findMember(obj, key) {
  if (!obj || obj.type !== "object") return null;
  for (let i = obj.members.length - 1; i >= 0; i--) if (obj.members[i].key === key) return obj.members[i];
  return null;
}

/** { line, column } (both 1-based) of a character offset. */
export function positionAt(text, offset) {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) { line++; last = i; }
  return { line, column: offset - last };
}

const isDigit = (c) => c >= 48 && c <= 57;

export function parseJsonc(input) {
  const bom = input.charCodeAt(0) === 0xfeff;
  const text = bom ? input.slice(1) : input;
  const shift = bom ? 1 : 0; // offsets are reported against the text as given, so the BOM counts as a character
  const n = text.length;
  const comments = [];
  const trailingCommas = [];
  const duplicates = [];
  let i = 0;

  class Stop extends Error {}
  const fail = (message, at = i) => { throw Object.assign(new Stop(message), { offset: at }); };

  // Skips white space and comments; the comments are recorded.
  function skip() {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
      if (c === 47) { // "/"
        const d = text[i + 1];
        if (d === "/") {
          const start = i;
          i += 2;
          while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
          comments.push({ kind: "line", start: start + shift, end: i + shift });
          continue;
        }
        if (d === "*") {
          const start = i;
          const close = text.indexOf("*/", i + 2);
          if (close === -1) fail("a /* comment is never closed", start);
          i = close + 2;
          comments.push({ kind: "block", start: start + shift, end: i + shift });
          continue;
        }
      }
      return;
    }
  }

  function string() {
    const start = i;
    i++;
    for (;;) {
      if (i >= n) fail("the string is never closed", start);
      const c = text.charCodeAt(i);
      if (c === 34) { i++; break; }
      if (c < 32) fail("a line break or control character inside a string (write \\n instead)", i);
      if (c === 92) {
        const e = text[i + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail("\\u needs four hexadecimal digits", i);
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail(`\\${e === undefined ? "" : e} is not a JSON escape`, i);
      } else i++;
    }
    const raw = text.slice(start, i);
    return { type: "string", start: start + shift, end: i + shift, raw, value: JSON.parse(raw) };
  }

  function number() {
    const start = i;
    if (text[i] === "-") i++;
    if (text[i] === "0") {
      i++;
      if (isDigit(text.charCodeAt(i))) fail("a number cannot start with a zero", start);
    } else if (isDigit(text.charCodeAt(i))) {
      while (isDigit(text.charCodeAt(i))) i++;
    } else fail("not a valid number", start);
    if (text[i] === ".") {
      i++;
      if (!isDigit(text.charCodeAt(i))) fail("a number needs digits after the point", start);
      while (isDigit(text.charCodeAt(i))) i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (!isDigit(text.charCodeAt(i))) fail("a number needs digits in its exponent", start);
      while (isDigit(text.charCodeAt(i))) i++;
    }
    const raw = text.slice(start, i);
    return { type: "number", start: start + shift, end: i + shift, raw, value: Number(raw) };
  }

  function describeBad() {
    const c = text[i];
    if (c === undefined) return "the text ends where a value was expected";
    if (c === "'") return "single quotes are not JSON; use double quotes";
    if (/[A-Za-z_$]/.test(c)) {
      const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))[0];
      if (word === "undefined" || word === "NaN" || word === "Infinity") return `${word} is not JSON`;
      return `unexpected "${word.slice(0, 20)}"`;
    }
    if (c === "+" || c === ".") return "not a valid number";
    return `unexpected character ${JSON.stringify(c)}`;
  }

  function value(depth, path) {
    if (depth >= MAX_DEPTH) fail(`nested more than ${MAX_DEPTH} levels deep`);
    const c = text[i];
    if (c === "{") return object(depth, path);
    if (c === "[") return array(depth, path);
    if (c === '"') return string();
    if (c === "-" || isDigit(text.charCodeAt(i))) return number();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(word, i)) {
        const start = i;
        i += word.length;
        return { type: "literal", start: start + shift, end: i + shift, raw: word, value: v };
      }
    }
    return fail(describeBad());
  }

  // After an element: finds the comma or the closing bracket. Returns the comma's offset (or null), and notes a
  // comma that nothing follows.
  function afterElement(close, what) {
    skip();
    if (text[i] === close) return null;
    if (text[i] !== ",") return fail(i >= n ? `the text ends before the ${what} is closed` : `expected "," or "${close}" here`);
    const at = i + shift;
    i++;
    skip();
    if (text[i] === close) trailingCommas.push(at);
    return at;
  }

  function object(depth, path) {
    const node = { type: "object", start: i + shift, end: 0, members: [], dangling: [] };
    const seen = new Map();
    i++;
    for (;;) {
      skip();
      if (text[i] === "}") { i++; break; }
      if (i >= n) fail("the text ends before the object is closed", node.start - shift);
      if (text[i] !== '"') {
        if (text[i] === "'") fail("single quotes are not JSON; use double quotes");
        if (/[A-Za-z_$]/.test(text[i])) fail("a key must be in double quotes");
        fail(text[i] === "," ? "a comma with nothing before it" : "expected a key in double quotes here");
      }
      const k = string();
      skip();
      if (text[i] !== ":") fail('expected ":" after the key');
      i++;
      skip();
      const member = { key: k.value, keyRaw: k.raw, keyStart: k.start, start: k.start, end: 0, value: null, comma: null, leading: [], trailing: [] };
      member.value = value(depth + 1, [...path, k.value]);
      member.end = member.value.end;
      if (seen.has(k.value)) duplicates.push({ key: k.value, start: member.start, firstStart: seen.get(k.value), path });
      else seen.set(k.value, member.start);
      node.members.push(member);
      member.comma = afterElement("}", "object");
    }
    node.end = i + shift;
    return node;
  }

  function array(depth, path) {
    const node = { type: "array", start: i + shift, end: 0, items: [], dangling: [] };
    i++;
    for (;;) {
      skip();
      if (text[i] === "]") { i++; break; }
      if (i >= n) fail("the text ends before the array is closed", node.start - shift);
      if (text[i] === ",") fail("a comma with nothing before it");
      const item = value(depth + 1, [...path, node.items.length]);
      item.comma = null;
      item.leading = [];
      item.trailing = [];
      node.items.push(item);
      item.comma = afterElement("]", "array");
    }
    node.end = i + shift;
    return node;
  }

  let root = null;
  let error = null;
  try {
    skip();
    if (i >= n) fail(comments.length ? "the file holds only comments, no JSON" : "the file is empty");
    root = value(0, []);
    skip();
    if (i < n) fail("there is more text after the end of the value");
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    error = { message: e.message, offset: e.offset + shift };
    root = null;
  }
  if (root) attachComments(input, root, comments);
  return { ok: error === null, error, root, comments, trailingCommas, duplicates, bom, text: input };
}

// Splits the comments of a gap into those on the line of the element before it (its trailing comments) and
// the rest. `anchor` is where that element, and its comma, ended.
function splitGap(text, anchor, gap) {
  let k = 0;
  while (k < gap.length && !/[\r\n]/.test(text.slice(anchor, gap[k].start))) { anchor = gap[k].end; k++; }
  return { trailing: gap.slice(0, k), rest: gap.slice(k) };
}

// Gives every element the comments that belong to it: the ones on its own line after it are trailing, the
// ones before it (down to the previous element's line) are leading, and what follows the last element is
// dangling.
function attachComments(text, root, comments) {
  // comments are in document order, so the first one at or after `from` is found by bisection
  const within = (from, to) => {
    let lo = 0;
    let hi = comments.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (comments[mid].start < from) lo = mid + 1; else hi = mid; }
    const out = [];
    for (; lo < comments.length && comments[lo].end <= to; lo++) out.push(comments[lo]);
    return out;
  };
  const visit = (node) => {
    if (node.type !== "object" && node.type !== "array") return;
    const els = node.type === "object" ? node.members : node.items;
    let from = node.start + 1;
    let prev = null;
    for (const el of els) {
      const gap = within(from, el.start);
      if (prev) {
        const { trailing, rest } = splitGap(text, prev.comma === null ? prev.end : prev.comma + 1, gap);
        prev.trailing = trailing;
        el.leading = rest;
      } else el.leading = gap;
      from = el.comma === null ? el.end : el.comma + 1;
      prev = el;
    }
    const tail = within(from, node.end - 1);
    if (prev) {
      const { trailing, rest } = splitGap(text, from, tail);
      prev.trailing = trailing;
      node.dangling = rest;
    } else node.dangling = tail;
    for (const el of els) visit(node.type === "object" ? el.value : el);
  };
  visit(root);
}
