// Keyboard layout fixer: turns what was typed on a Cyrillic layout into what the same physical keys give on an English
// QWERTY layout (`дщсфд ы = ЭПриветЭ` -> `local s = "Привет"`). Free of VS Code dependencies so it can be unit-tested.
//
// Only code is converted: comments and string literals are left alone (both can be switched on in the options).
// A Cyrillic key that gives a quote (`э` / `Э`) opens a string at once; what follows it is Russian text again until the
// string is closed.

"use strict";

const BACKSLASH = String.fromCharCode(92);

// Physical keys of the Russian layout and what the same keys give on QWERTY, without and with Shift.
const RU_LOW = "йцукенгшщзхъфывапролджэячсмитьбюё";
const EN_LOW = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU_UP = "ЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮЁ";
const EN_UP = "QWERTYUIOP{}ASDFGHJKL:\"ZXCVBNM<>~";

// Letters of the other layouts that differ from the Russian one.
const EXTRA = {
	ru: {},
	uk: { "і": "s", "І": "S", "ї": "]", "Ї": "}", "є": "'", "Є": "\"", "ґ": BACKSLASH, "Ґ": "|" },
	be: { "і": "s", "І": "S", "ў": "o", "Ў": "O" },
};

// What the keys of the number row give on the Russian layout, when the layout is not known: a typed `.` could just as well
// be an English one, so these are only changed next to Cyrillic letters (see `walk`).
// (`"` is not among them: a quote in code opens a string, and a real string with Russian text must stay as it is.)
const AMBIGUOUS = { ".": "/", ",": "?", "№": "#", ";": "$", ":": "^", "?": "&" };

const LAYOUTS = ["ru", "uk", "be"];
const PROFILES = ["physicalQwerty", "hybridSmart", "keepLocalPunctuation"];
const MODES = ["live", "allCodeWords", "keywordsOnly", "off"];

/** Words that `keywordsOnly` converts. */
const KEYWORDS = new Set([
	"and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in", "local", "nil", "not", "or",
	"repeat", "return", "then", "true", "until", "while",
	"continue", "switch", "case", "default", "class", "extends", "new", "enum", "begin", "try", "catch", "finally", "export",
	"static", "public", "private", "protected", "namespace", "parent", "const", "global", "pluto_switch", "pluto_class",
	"pluto_enum", "pluto_try", "pluto_catch", "pluto_new", "pluto_export", "pluto_use", "pluto_uses",
]);

/** How far from the plain letters a target goes: 0 letters and quotes, 1 brackets and `;` `:`, 2 the rest. */
function tier(target)
{
	if (/^[a-zA-Z'"]$/.test(target))
	{
		return 0;
	}
	return /^[\[\]{};:]$/.test(target) ? 1 : 2;
}

const isCyrillic = (ch) => ch.charCodeAt(0) >= 128;

/**
 * The conversion table of the options.
 * @param {{ sourceLayouts?: string[], baseKeyboardProfile?: string, customMap?: Record<string, string> }} [options]
 * @returns {{ map: Map<string, string>, quotes: Set<string>, ambiguous: Map<string, string>|null }}
 */
function buildLayout(options)
{
	options = options || {};
	const layouts = Array.isArray(options.sourceLayouts) ? options.sourceLayouts.filter(l => LAYOUTS.includes(l)) : ["ru"];
	const profile = PROFILES.includes(options.baseKeyboardProfile) ? options.baseKeyboardProfile : "physicalQwerty";
	const maxTier = profile == "physicalQwerty" ? 2 : (profile == "hybridSmart" ? 1 : 0);
	const full = new Map();
	if (layouts.includes("ru"))
	{
		for (let i = 0; i < RU_LOW.length; ++i)
		{
			full.set(RU_LOW[i], EN_LOW[i]);
			full.set(RU_UP[i], EN_UP[i]);
		}
	}
	for (const name of layouts)
	{
		for (const [from, to] of Object.entries(EXTRA[name]))
		{
			full.set(from, to);
		}
	}
	// Belarusian has no `щ`, `ъ`, `ы`, Ukrainian no `ы`, `э`, `ъ`: they are only there with the Russian layout.
	const map = new Map();
	for (const [from, to] of full)
	{
		if (tier(to) <= maxTier)
		{
			map.set(from, to);
		}
	}
	const custom = options.customMap && typeof options.customMap == "object" ? options.customMap : {};
	for (const [from, to] of Object.entries(custom))
	{
		if (Array.from(from).length != 1 || typeof to != "string")
		{
			continue;
		}
		if (to === "")
		{
			map.delete(from);
		}
		else
		{
			map.set(from, to);
		}
	}
	const quotes = new Set();
	for (const [from, to] of map)
	{
		if ((to == "\"" || to == "'") && isCyrillic(from))
		{
			quotes.add(from);
		}
	}
	return { map, quotes, ambiguous: profile == "physicalQwerty" ? new Map(Object.entries(AMBIGUOUS)) : null };
}

const DEFAULTS = { ignoreComments: true, ignoreStrings: true, autoCloseCyrillicQuotes: true };

/**
 * Walks `text` from its start up to `end`, following comments and strings, and collects what has to be converted
 * in `[from, to)`.
 * @param {string} text
 * @param {number} end
 * @param {ReturnType<typeof buildLayout>} layout
 * @param {{ ignoreComments?: boolean, ignoreStrings?: boolean, autoCloseCyrillicQuotes?: boolean, simulate?: boolean }} opts
 *   With `simulate` a Cyrillic quote in code opens a string (and closes it again), as it would have when typed.
 * @param {{ from: number, to: number }} [range]
 * @returns {{ edits: { start: number, end: number, text: string }[], state: { kind: string, quote?: string, open?: number, cyr?: boolean } }}
 */
function walk(text, end, layout, opts, range)
{
	opts = Object.assign({}, DEFAULTS, opts);
	const edits = [];
	let st = { kind: "code" };
	const inRange = (i) => range && i >= range.from && i < range.to;
	const put = (i, to) => { if (inRange(i)) { edits.push({ start: i, end: i + 1, text: to }); } };
	const nearCyrillic = (i) => (i > 0 && layout.map.has(text[i - 1]) && isCyrillic(text[i - 1])) || (i + 1 < text.length && layout.map.has(text[i + 1]) && isCyrillic(text[i + 1]));
	let i = 0;
	while (i < end)
	{
		const c = text[i];
		switch (st.kind)
		{
			case "line-comment":
				if (c == "\n")
				{
					st = { kind: "code" };
				}
				else if (!opts.ignoreComments && layout.map.has(c))
				{
					put(i, layout.map.get(c));
				}
				++i;
				break;
			case "block-comment":
			case "long-string":
				if (text.startsWith(st.close, i))
				{
					i += st.close.length;
					st = { kind: "code" };
					break;
				}
				if (layout.map.has(c) && (st.kind == "block-comment" ? !opts.ignoreComments : !opts.ignoreStrings))
				{
					put(i, layout.map.get(c));
				}
				++i;
				break;
			case "string":
				if (c == BACKSLASH)
				{
					i += 2;
				}
				else if (c == st.quote)
				{
					st = { kind: "code" };
					++i;
				}
				else if (opts.simulate && st.cyr && opts.autoCloseCyrillicQuotes && layout.quotes.has(c) && layout.map.get(c) == st.quote && i > st.open + 1)
				{
					put(i, st.quote);
					st = { kind: "code" };
					++i;
				}
				else
				{
					if (c == "\n")
					{
						st = { kind: "code" };
					}
					else if (!opts.ignoreStrings && layout.map.has(c))
					{
						put(i, layout.map.get(c));
					}
					++i;
				}
				break;
			default: // code
			{
				if (c == "-" && text[i + 1] == "-")
				{
					const m = /^\[(=*)\[/.exec(text.slice(i + 2, i + 80));
					st = m ? { kind: "block-comment", close: "]" + m[1] + "]" } : { kind: "line-comment" };
					i += 2 + (m ? m[0].length : 0);
					break;
				}
				if (c == "[")
				{
					const m = /^\[(=*)\[/.exec(text.slice(i, i + 80));
					if (m)
					{
						st = { kind: "long-string", close: "]" + m[1] + "]" };
						i += m[0].length;
						break;
					}
				}
				if (c == "\"" || c == "'")
				{
					st = { kind: "string", quote: c, open: i };
					++i;
					break;
				}
				if (layout.map.has(c))
				{
					const to = layout.map.get(c);
					if (opts.simulate && layout.quotes.has(c))
					{
						put(i, to);
						st = { kind: "string", quote: to, open: i, cyr: true };
					}
					else
					{
						put(i, to);
					}
				}
				else if (layout.ambiguous && layout.ambiguous.has(c) && nearCyrillic(i))
				{
					put(i, layout.ambiguous.get(c));
				}
				++i;
			}
		}
	}
	return { edits, state: st };
}

/** Whether a state is one where Cyrillic is converted. */
function convertibleState(state, opts)
{
	opts = Object.assign({}, DEFAULTS, opts);
	switch (state.kind)
	{
		case "code":
			return true;
		case "line-comment":
		case "block-comment":
			return !opts.ignoreComments;
		default:
			return !opts.ignoreStrings;
	}
}

/**
 * What to do with a character that was just typed at `offset` (it is already in `text`). `null`: leave it.
 * @param {string} text The document with the typed character.
 * @param {number} offset
 * @param {ReturnType<typeof buildLayout>} layout
 * @param {{ mode?: string, ignoreComments?: boolean, ignoreStrings?: boolean, autoCloseCyrillicQuotes?: boolean }} opts
 * @returns {{ start: number, end: number, text: string }|null}
 */
function liveChange(text, offset, layout, opts)
{
	opts = Object.assign({}, DEFAULTS, opts);
	const ch = text[offset];
	if (ch === undefined || !layout.map.has(ch) || !MODES.includes(opts.mode) || opts.mode == "off")
	{
		return null;
	}
	const to = layout.map.get(ch);
	const isQuote = layout.quotes.has(ch);
	const { state } = walk(text, offset, layout, opts);
	if (state.kind == "string" && opts.ignoreStrings)
	{
		// The end of a string typed with a Cyrillic quote key. An empty string stays: `Э` there is most likely a letter.
		if (opts.autoCloseCyrillicQuotes && isQuote && to == state.quote && offset > state.open + 1)
		{
			return { start: offset, end: offset + 1, text: to };
		}
		return null;
	}
	if (!convertibleState(state, opts))
	{
		return null;
	}
	return isQuote || opts.mode == "live" ? { start: offset, end: offset + 1, text: to } : null;
}

/** Whether the typed text ends a word (a space, a line break with its indentation, a sign). */
function isDelimiter(typed)
{
	if (/^\r?\n[ \t]*$/.test(typed))
	{
		return true;
	}
	return typed.length == 1 && typed.charCodeAt(0) < 128 && !/\w/.test(typed);
}

/**
 * The word before `offset` (where a delimiter was typed), converted: `allCodeWords` converts any word of Cyrillic keys
 * in code, `keywordsOnly` only those that give a keyword.
 * @returns {{ start: number, end: number, text: string }|null}
 */
function wordChange(text, offset, layout, opts)
{
	opts = Object.assign({}, DEFAULTS, opts);
	if (opts.mode != "allCodeWords" && opts.mode != "keywordsOnly")
	{
		return null;
	}
	let start = offset;
	while (start > 0 && layout.map.has(text[start - 1]) && isCyrillic(text[start - 1]) && !layout.quotes.has(text[start - 1]))
	{
		--start;
	}
	if (start == offset || (start > 0 && /\w/.test(text[start - 1]) && text.charCodeAt(start - 1) < 128))
	{
		return null; // nothing, or a word that is partly English
	}
	if (!convertibleState(walk(text, start, layout, opts).state, opts))
	{
		return null;
	}
	let out = "";
	for (const c of text.slice(start, offset))
	{
		out += layout.map.get(c);
	}
	if (opts.mode == "keywordsOnly" && !KEYWORDS.has(out))
	{
		return null;
	}
	return { start, end: offset, text: out };
}

/**
 * The manual conversion of `[from, to)` (all of the text when omitted).
 * @returns {{ start: number, end: number, text: string }[]}
 */
function convertRange(text, from, to, layout, opts)
{
	from = from === undefined ? 0 : from;
	to = to === undefined ? text.length : to;
	return walk(text, to, layout, Object.assign({}, opts, { simulate: true }), { from, to }).edits;
}

/** Applies edits (they do not overlap) to a text. */
function applyEdits(text, edits)
{
	let out = text;
	for (const e of edits.slice().sort((a, b) => b.start - a.start))
	{
		out = out.slice(0, e.start) + e.text + out.slice(e.end);
	}
	return out;
}

module.exports = { buildLayout, walk, liveChange, wordChange, isDelimiter, convertRange, applyEdits, convertibleState, KEYWORDS, LAYOUTS, PROFILES, MODES, DEFAULTS };
