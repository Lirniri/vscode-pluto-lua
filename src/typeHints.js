// Type hints (`a: int`, `): string`, `local x: Foo?`): where they can stand and which of them are
// nullable (`?int` or `int?`). Free of VS Code dependencies so it can be unit-tested with plain Node.

"use strict";

const { tokenize } = require("./parser");
const { t } = require("./i18n");

// The text before the type being typed, e.g. `function f(ped: ?int|` or `local count: `.
const TYPE_TAIL = ":\\s*(?:[?\\w.]+\\s*\\|\\s*)*\\??\\s*$";
const TYPE_HINT_POSITIONS = [
	// parameter of a function declaration: `function f(a, ped: ` / `function(ped: `
	new RegExp("\\bfunction\\b[\\w.:\\s]*\\([^()]*\\b\\w+\\s*" + TYPE_TAIL),
	// return type: `function f(a): `
	new RegExp("\\bfunction\\b[\\w.:\\s]*\\([^()]*\\)\\s*" + TYPE_TAIL),
	// `local count: `, `local a: int, b: `, `public name: `, `static x: `
	new RegExp("^\\s*(?:(?:local|export|public|private|protected|static|const)\\s+)+(?:\\w+\\s*(?::\\s*[^,=]+)?,\\s*)*\\w+\\s*" + TYPE_TAIL),
	// class field without modifier, written with a space after the colon: `name: string` (not `default: ` of a switch)
	new RegExp("^\\s*(?!(?:default|case)\\b)\\w+:\\s+(?:[?\\w.]+\\s*\\|\\s*)*\\??\\s*$"),
];

/**
 * Whether completion at the end of `before` is inside a type hint.
 * `self:` / `obj:` (method calls) don't count.
 * @param {string} before Text of the line up to the cursor.
 */
function isTypeHintPosition(before)
{
	return TYPE_HINT_POSITIONS.some(re => re.test(before));
}

/**
 * Whether a type is nullable: `?int`, `int?` (or `string|int?`).
 * @param {string|undefined} type
 */
function isNullableType(type)
{
	return !!type && /^\s*\?|\?\s*$/.test(type);
}

/**
 * Hover/signature text for a nullable type.
 * @param {string} type The type as written, e.g. `int?`.
 * @returns {{ title: string, text: string }}
 */
function describeNullable(type)
{
	const written = type.replace(/\s+/g, "");
	const base = written.replace(/^\?|\?$/g, "");
	return {
		title: t("label.nullableType") + " " + written,
		text: t("nullable.text", base),
	};
}

/**
 * The union type (`int|string`, `?int|string`) whose `|` is at `character` of a line, if that
 * `|` is inside a type hint (a lambda `|x|` or a bitwise or is not).
 * @param {string} lineText
 * @param {number} character
 * @returns {{ start: number, end: number, members: { text: string, base: string, nullable: boolean }[] }|null}
 */
function unionAt(lineText, character)
{
	if (lineText[character] != "|")
	{
		return null;
	}
	const members = [];
	// Members to the left of the `|`, nearest first.
	let k = character;
	let start = character;
	for (;;)
	{
		let j = k - 1;
		while (j >= 0 && /\s/.test(lineText[j]))
		{
			--j;
		}
		const end = j + 1;
		const trailing = lineText[j] == "?";
		if (trailing)
		{
			--j;
		}
		const nameEnd = j + 1;
		while (j >= 0 && /[\w.]/.test(lineText[j]))
		{
			--j;
		}
		if (j + 1 == nameEnd)
		{
			return null;
		}
		const base = lineText.slice(j + 1, nameEnd);
		const leading = lineText[j] == "?";
		if (leading)
		{
			--j;
		}
		start = j + 1;
		members.unshift({ text: lineText.slice(start, end).replace(/\s+/g, ""), base, nullable: leading || trailing });
		while (j >= 0 && /\s/.test(lineText[j]))
		{
			--j;
		}
		if (lineText[j] != "|")
		{
			break;
		}
		k = j;
	}
	if (!isTypeHintPosition(lineText.slice(0, start)))
	{
		return null;
	}
	// Members to the right.
	let end = character;
	let pos = character;
	while (lineText[pos] == "|")
	{
		let j = pos + 1;
		while (j < lineText.length && /\s/.test(lineText[j]))
		{
			++j;
		}
		const from = j;
		const leading = lineText[j] == "?";
		if (leading)
		{
			++j;
		}
		const nameStart = j;
		while (j < lineText.length && /[\w.]/.test(lineText[j]))
		{
			++j;
		}
		if (j == nameStart)
		{
			break;
		}
		const base = lineText.slice(nameStart, j);
		const trailing = lineText[j] == "?" && !/^\?[.?[]/.test(lineText.slice(j));
		if (trailing)
		{
			++j;
		}
		members.push({ text: lineText.slice(from, j), base, nullable: leading || trailing });
		end = j;
		while (j < lineText.length && /\s/.test(lineText[j]))
		{
			++j;
		}
		pos = j;
	}
	return members.length > 1 ? { start, end, members } : null;
}

/**
 * Hover text for a union type: what it can hold, with `nil` made explicit.
 * @param {{ members: { text: string, base: string, nullable: boolean }[] }} union
 * @returns {{ title: string, text: string }}
 */
function describeUnion(union)
{
	const bases = [];
	let hasNil = false;
	for (const m of union.members)
	{
		if (m.base == "nil")
		{
			hasNil = true;
			continue;
		}
		hasNil = hasNil || m.nullable;
		if (!bases.includes(m.base))
		{
			bases.push(m.base);
		}
	}
	let text = t("union.text") + "\n\n" + bases.concat(hasNil ? ["nil"] : []).map(b => "- `" + b + "`").join("\n");
	if (hasNil && bases.length == 1)
	{
		text += "\n\n" + t("union.sameAs", bases[0]);
	}
	return { title: t(hasNil ? "union.labelNil" : "union.label") + " " + union.members.map(m => m.text).join(" | "), text };
}

const isP = (tokens, idx, v) => tokens[idx] !== undefined && tokens[idx].t == "p" && tokens[idx].v == v;
const isId = (tokens, idx) => tokens[idx] !== undefined && tokens[idx].t == "id";

// Whether the `(` at token `open` starts the parameter list of a function declaration.
function isFunctionParen(tokens, open)
{
	let k = open - 1;
	if (isId(tokens, k) && tokens[k].v == "function")
	{
		return true;
	}
	// `function a.b:c(`
	while (isId(tokens, k) && k >= 1 && (isP(tokens, k - 1, ".") || isP(tokens, k - 1, ":")))
	{
		k -= 2;
	}
	return isId(tokens, k) && k >= 1 && isId(tokens, k - 1) && tokens[k - 1].v == "function";
}

// Whether the `:` at token `i` introduces a type hint (as opposed to `obj:method()` or a ternary).
function isDeclarationColon(tokens, i, lines)
{
	const colon = tokens[i];
	const next = tokens[i + 1];
	const before = lines[colon.line].slice(0, next.col);
	if (isTypeHintPosition(before))
	{
		return true;
	}
	// Parameters on lines of their own.
	let k = i - 1;
	let depth = 0;
	if (isP(tokens, k, ")"))
	{
		// `): type` — find the `(` this closes.
		for (; k >= 0; --k)
		{
			if (isP(tokens, k, ")"))
			{
				++depth;
			}
			else if (isP(tokens, k, "(") && --depth == 0)
			{
				return isFunctionParen(tokens, k);
			}
		}
		return false;
	}
	if (!isId(tokens, k))
	{
		return false;
	}
	for (--k; k >= 0 && i - k < 400; --k)
	{
		const t = tokens[k];
		if (t.t != "p")
		{
			continue;
		}
		if (t.v == ")" || t.v == "]" || t.v == "}")
		{
			++depth;
		}
		else if (t.v == "[" || t.v == "{")
		{
			if (depth == 0)
			{
				return false;
			}
			--depth;
		}
		else if (t.v == "(")
		{
			if (depth == 0)
			{
				return isFunctionParen(tokens, k);
			}
			--depth;
		}
	}
	return false;
}

/**
 * Ranges of the nullable types written in type hints of a source file: `int?`, `?string`,
 * `Vehicle?`, and members of unions such as `string|int?`.
 * @param {string} text
 * @returns {{ line: number, col: number, endCol: number, text: string }[]}
 */
function findNullableTypes(text)
{
	const tokens = tokenize(text);
	const lines = text.split(/\r?\n/);
	const out = [];
	for (let i = 1; i + 1 < tokens.length; ++i)
	{
		const colon = tokens[i];
		if (colon.t != "p" || colon.v != ":" || tokens[i + 1].line != colon.line || !isDeclarationColon(tokens, i, lines))
		{
			continue;
		}
		let j = i + 1;
		while (j < tokens.length && tokens[j].line == colon.line)
		{
			const first = j;
			const leading = isP(tokens, j, "?");
			if (leading)
			{
				++j;
			}
			if (!isId(tokens, j) || tokens[j].line != colon.line)
			{
				break;
			}
			let last = j;
			while (isP(tokens, last + 1, ".") && isId(tokens, last + 2) && tokens[last + 2].line == colon.line)
			{
				last += 2;
			}
			const trailing = isP(tokens, last + 1, "?") && tokens[last + 1].off == tokens[last].end;
			if (trailing)
			{
				++last;
			}
			if (leading || trailing)
			{
				const a = tokens[first];
				const b = tokens[last];
				out.push({ line: a.line, col: a.col, endCol: b.col + (b.end - b.off), text: text.slice(a.off, b.end) });
			}
			j = last + 1;
			if (!isP(tokens, j, "|"))
			{
				break;
			}
			++j;
		}
	}
	return out;
}

module.exports = { isTypeHintPosition, isNullableType, describeNullable, findNullableTypes, unionAt, describeUnion };
