// More hints for typing, built the same way as the others: a colon after a parameter name that has no type, after the
// `)` of a function without a return type and after the value of a `case`; the values that fit a `return`; `break`,
// `case` and `default` inside of a `switch`; and the diagnostics of a function that does not return what it says and of
// a `case` that falls into the next one. Free of VS Code dependencies so it can be unit-tested with plain Node.

"use strict";

const { tokenize, RESERVED } = require("./parser");
const { isParamsParen, isFunctionType, analyze, stripComment, indentOf, BLOCK_OPENERS, NEEDS_DO, UNFINISHED } = require("./multilineFormat");
const { defaultValuesFor, isCompleteType } = require("./defaultValues");
const { inCode } = require("./autoFormat");

const isP = (tok, v) => !!tok && tok.t == "p" && tok.v == v;
const isId = (tok, v) => !!tok && tok.t == "id" && (v === undefined || tok.v == v);
const OPENERS = { "(": ")", "{": "}", "[": "]" };
const CLOSERS = { ")": "(", "}": "{", "]": "[" };

/** Where a line starts and ends in a text, and the line itself. */
function lineAround(text, offset)
{
	const start = text.lastIndexOf("\n", offset - 1) + 1;
	let end = text.indexOf("\n", offset);
	if (end == -1)
	{
		end = text.length;
	}
	return { start, end, text: text.slice(start, end).replace(/\r$/, "") };
}

// ---------------------------------------------------------------------------------------------
// A parameter name without a type
// ---------------------------------------------------------------------------------------------

/**
 * The parameter of a function declaration the cursor is on, if it is a bare name: `function f(a, value2|)`.
 * @param {string} text
 * @param {number} offset
 * @returns {{ name: string, nameStart: number, nameEnd: number, line: number, col: number }|null}
 */
function untypedParamAt(text, offset)
{
	const around = lineAround(text, offset);
	const tokens = tokenize(text.slice(0, around.end));
	const stack = [];
	for (let idx = 0; idx < tokens.length; ++idx)
	{
		const tok = tokens[idx];
		if (tok.off >= offset)
		{
			break;
		}
		if (tok.t != "p")
		{
			continue;
		}
		if (OPENERS[tok.v])
		{
			stack.push({ ch: tok.v, idx });
		}
		else if (CLOSERS[tok.v])
		{
			for (let k = stack.length - 1; k >= 0; --k)
			{
				if (stack[k].ch == CLOSERS[tok.v])
				{
					stack.length = k;
					break;
				}
			}
		}
	}
	const top = stack[stack.length - 1];
	if (!top || top.ch != "(" || !isParamsParen(tokens, top.idx))
	{
		return null;
	}
	// The parameter between the commas around the cursor, on this line.
	let depth = 0;
	let first = top.idx + 1;
	let last = tokens.length - 1;
	for (let idx = top.idx + 1; idx < tokens.length; ++idx)
	{
		const t = tokens[idx];
		if (t.t == "p" && OPENERS[t.v])
		{
			++depth;
		}
		else if (t.t == "p" && CLOSERS[t.v])
		{
			if (depth == 0)
			{
				last = idx - 1;
				break;
			}
			--depth;
		}
		else if (depth == 0 && isP(t, ","))
		{
			if (t.off < offset)
			{
				first = idx + 1;
			}
			else
			{
				last = idx - 1;
				break;
			}
		}
	}
	const span = tokens.slice(first, last + 1).filter(t => t.off >= around.start && t.off < around.end);
	let i = 0;
	if (isP(span[i], "..."))
	{
		++i;
	}
	const name = span[i];
	if (!name || name.t != "id" || span.length != i + 1 || RESERVED.has(name.v) || name.v == "self" || offset < name.off)
	{
		return null;
	}
	return { name: name.v, nameStart: name.off, nameEnd: name.end, line: name.line, col: name.col };
}

// ---------------------------------------------------------------------------------------------
// The return type of a function
// ---------------------------------------------------------------------------------------------

/** The tokens of the header of the function at token `fi`: where its `)` is, and its return type if it has one. */
function functionHeader(tokens, fi, text)
{
	let open = -1;
	for (let k = fi + 1; k < tokens.length && k < fi + 14; ++k)
	{
		if (isP(tokens[k], "("))
		{
			open = k;
			break;
		}
		if (!(isId(tokens[k]) || isP(tokens[k], ".") || isP(tokens[k], ":")))
		{
			return null;
		}
	}
	if (open == -1)
	{
		return null;
	}
	let depth = 0;
	let close = -1;
	for (let k = open; k < tokens.length; ++k)
	{
		if (isP(tokens[k], "(") || isP(tokens[k], "{") || isP(tokens[k], "["))
		{
			++depth;
		}
		else if (isP(tokens[k], ")") || isP(tokens[k], "}") || isP(tokens[k], "]"))
		{
			--depth;
			if (depth == 0)
			{
				close = k;
				break;
			}
		}
	}
	if (close == -1)
	{
		return null;
	}
	const out = { open, close, retType: null, typeStart: -1, typeEnd: -1, bodyStart: close + 1 };
	if (isP(tokens[close + 1], ":"))
	{
		// The type: names, `.`, `?`, `|` and groups of brackets.
		let k = close + 2;
		let d = 0;
		let first = null;
		let last = null;
		let beforeLast = null;
		for (; k < tokens.length; ++k)
		{
			const t = tokens[k];
			if (d == 0 && !(isId(t) || isP(t, ".") || isP(t, "?") || isP(t, "|") || isP(t, "{") || isP(t, "(") || isP(t, "[")))
			{
				break;
			}
			// A name goes on a type after `|` and `.`, or after a leading `?`: another one is the body.
			const nameFits = !last || isP(last, "|") || isP(last, ".") || (isP(last, "?") && (!beforeLast || isP(beforeLast, "|")));
			if (d == 0 && isId(t) && !nameFits)
			{
				break;
			}
			if (isP(t, "{") || isP(t, "(") || isP(t, "["))
			{
				++d;
			}
			else if (isP(t, "}") || isP(t, ")") || isP(t, "]"))
			{
				--d;
			}
			first = first || t;
			beforeLast = last;
			last = t;
		}
		if (first)
		{
			out.retType = text.slice(first.off, last.end).trim();
			out.typeStart = first.off;
			out.typeEnd = last.end;
			out.bodyStart = k;
		}
	}
	return out;
}

/**
 * The `)` that ends the parameter list of a function declaration, when the cursor is right behind it and no return
 * type follows: `function f(a)|`.
 * @returns {{ line: number, col: number }|null}
 */
function returnColonAt(text, offset)
{
	const around = lineAround(text, offset);
	const tokens = tokenize(text.slice(0, around.end));
	let closeIdx = -1;
	for (let i = 0; i < tokens.length; ++i)
	{
		if (tokens[i].end <= offset && isP(tokens[i], ")") && text.slice(tokens[i].end, offset).trim() == "")
		{
			closeIdx = i;
		}
	}
	if (closeIdx == -1 || tokens[closeIdx].end > offset)
	{
		return null;
	}
	const close = tokens[closeIdx];
	if (close.line != around.text && close.off < around.start && text.slice(close.end, offset).trim() != "")
	{
		return null;
	}
	let depth = 0;
	let open = -1;
	for (let k = closeIdx; k >= 0; --k)
	{
		if (isP(tokens[k], ")") || isP(tokens[k], "}") || isP(tokens[k], "]"))
		{
			++depth;
		}
		else if (isP(tokens[k], "(") || isP(tokens[k], "{") || isP(tokens[k], "["))
		{
			--depth;
			if (depth == 0)
			{
				open = k;
				break;
			}
		}
	}
	if (open == -1 || !isParamsParen(tokens, open))
	{
		return null;
	}
	// A function that has its return type already, or something that is no body after the bracket.
	const rest = text.slice(offset, around.end);
	if (/^\s*:/.test(rest) || /^\s*[\w"'(]/.test(rest) && !/^\s*(?:return|end|local|if|for|while|do|print)\b/.test(rest))
	{
		return null;
	}
	return { line: close.line, col: close.col };
}

/**
 * The type a `return` at the cursor has to give back, from the header of the function around it.
 * @returns {string|null}
 */
function enclosingReturnType(text, line)
{
	const { tokens, stack } = analyze(text, line);
	for (let k = stack.length - 1; k >= 0; --k)
	{
		if (stack[k].kind == "block" && stack[k].name == "function")
		{
			const header = functionHeader(tokens, stack[k].idx, text);
			return header ? header.retType : null;
		}
	}
	return null;
}

/**
 * The values for a `return`: `return |` in a function that says `: bool` offers `true` and `false`.
 * @param {string} text
 * @param {number} offset
 * @param {(name: string) => boolean} [isClass]
 * @returns {string[]}
 */
function returnValuesAt(text, offset, isClass)
{
	const around = lineAround(text, offset);
	const before = text.slice(around.start, offset);
	if (!inCode(before) || !/^\s*return\s$/.test(before) || text.slice(offset, around.end).trim() != "")
	{
		return [];
	}
	const type = enclosingReturnType(text, around.text == "" ? 0 : text.slice(0, offset).split("\n").length - 1);
	if (!type || type == "void" || !isCompleteType(type, isClass))
	{
		return [];
	}
	return defaultValuesFor(type, isClass);
}

/**
 * Functions that do not give back what their header says: no `return` at all in a function with a return type, and a
 * value returned from a `: void` one.
 * @param {string} text
 * @returns {{ kind: "missing"|"void-value", type: string, line: number, col: number, endCol: number }[]}
 */
function findReturnProblems(text)
{
	const tokens = tokenize(text);
	const out = [];
	const stack = [];
	for (let idx = 0; idx < tokens.length; ++idx)
	{
		const tok = tokens[idx];
		// What the body of the function around has in it.
		const around = [...stack].reverse().find(e => e.name == "function");
		if (around && around.header && idx >= around.header.bodyStart)
		{
			++around.bodyTokens;
		}
		if (tok.t != "id")
		{
			continue;
		}
		const v = tok.v;
		if (v == "end" || v == "until")
		{
			for (let k = stack.length - 1; k >= 0; --k)
			{
				if (v == "until" ? stack[k].name == "repeat" : true)
				{
					const entry = stack[k];
					stack.length = k;
					if (entry.name == "function" && entry.header && entry.header.retType && entry.bodyTokens > 1)
					{
						const type = entry.header.retType;
						// A nullable type can give back nothing, `void` and `any` do not promise a value.
						if (!entry.returns && !entry.stops && !["void", "nil", "any", "mixed"].includes(type) && !/^\?|\?$|\bnil\b/.test(type))
						{
							const t0 = tokens.find(t => t.off == entry.header.typeStart);
							out.push({ kind: "missing", type, line: t0.line, col: t0.col, endCol: t0.col + (entry.header.typeEnd - entry.header.typeStart) });
						}
					}
					break;
				}
			}
		}
		else if (v == "do")
		{
			const top = stack[stack.length - 1];
			if (top && top.needsDo)
			{
				top.needsDo = false;
			}
			else
			{
				stack.push({ name: "do" });
			}
		}
		else if (BLOCK_OPENERS.has(v) && !isP(tokens[idx - 1], "."))
		{
			const afterEnum = (v == "class" || v == "pluto_class") && (isId(tokens[idx - 1], "enum") || isId(tokens[idx - 1], "pluto_enum"));
			if (afterEnum || (v == "function" && isFunctionType(tokens, idx)))
			{
				continue;
			}
			const entry = { name: v, needsDo: NEEDS_DO.has(v), bodyTokens: 0, returns: 0, stops: 0 };
			if (v == "function")
			{
				entry.header = functionHeader(tokens, idx, text);
			}
			stack.push(entry);
		}
		else
		{
			const owner = [...stack].reverse().find(e => e.name == "function");
			if (!owner)
			{
				continue;
			}
			if (v == "return")
			{
				++owner.returns;
				const next = tokens[idx + 1];
				const valueful = !!next && !(isId(next) && ["end", "else", "elseif", "until", "case", "default"].includes(next.v)) && !isP(next, ";");
				if (valueful && owner.header && owner.header.retType == "void")
				{
					out.push({ kind: "void-value", type: "void", line: tok.line, col: tok.col, endCol: tok.col + 6 });
				}
			}
			else if (v == "goto" || (v == "error" && isP(tokens[idx + 1], "(")))
			{
				++owner.stops;
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// switch / case
// ---------------------------------------------------------------------------------------------

/** `case` header lines that are inside of a `switch`: the colon after the values. */
function caseHeaderAt(text, offset)
{
	const around = lineAround(text, offset);
	const line = text.slice(0, offset).split("\n").length - 1;
	const m = /^(\s*)case\s+(\S.*?)\s*$/.exec(stripComment(around.text));
	if (!m || /:$/.test(m[2]) || !inCode(around.text) || UNFINISHED.test(m[2]))
	{
		return null;
	}
	const { stack } = analyze(text, line);
	const top = stack[stack.length - 1];
	if (!top || top.kind != "block" || (top.name != "switch" && top.name != "pluto_switch"))
	{
		return null;
	}
	const col = around.text.indexOf("case");
	return { line, col, endCol: col + 4, valuesEnd: around.text.replace(/\s+$/, "").length };
}

/** A `case` that has no colon yet, with the cursor right behind its values (for the grey colon). */
function caseColonAt(text, offset)
{
	const header = caseHeaderAt(text, offset);
	const around = lineAround(text, offset);
	if (!header || offset - around.start < header.valuesEnd || text.slice(around.start + header.valuesEnd, offset).trim() != "" || text.slice(offset, around.end).trim() != "")
	{
		return null;
	}
	return header;
}

/** A `case` without a colon, wherever the cursor is on its line (for the yellow line). */
function caseNoColonAt(text, offset)
{
	return caseHeaderAt(text, offset);
}

const TERMINATORS = new Set(["break", "return", "goto", "continue"]);

/**
 * The `case` and `default` words at the level of a switch, before an offset (or to its `end`): nested blocks are skipped,
 * and the `do` of the switch itself (and of the loops inside) is not a block of its own.
 */
function switchCases(tokens, switchIdx, limitOff)
{
	const cases = [];
	let depth = 0;
	let pendingDo = 1; // the `do` of the switch
	for (let k = switchIdx + 1; k < tokens.length; ++k)
	{
		const t = tokens[k];
		if (limitOff !== undefined && t.off >= limitOff)
		{
			break;
		}
		if (t.t != "id")
		{
			continue;
		}
		if (t.v == "do")
		{
			if (pendingDo > 0)
			{
				--pendingDo;
			}
			else
			{
				++depth;
			}
		}
		else if (t.v == "end" || t.v == "until")
		{
			if (depth == 0)
			{
				break;
			}
			--depth;
		}
		else if ((t.v == "case" || t.v == "default") && depth == 0 && !isP(tokens[k - 1], "."))
		{
			cases.push({ tok: t, idx: k, isDefault: t.v == "default" });
		}
		else if (BLOCK_OPENERS.has(t.v) && !isP(tokens[k - 1], ".") && !(t.v == "function" && isFunctionType(tokens, k)))
		{
			const afterEnum = (t.v == "class" || t.v == "pluto_class") && (isId(tokens[k - 1], "enum") || isId(tokens[k - 1], "pluto_enum"));
			if (!afterEnum)
			{
				++depth;
				if (NEEDS_DO.has(t.v))
				{
					++pendingDo;
				}
			}
		}
	}
	return cases;
}

/** The switch the cursor line is in (an empty line), and the cases above it. */
function caseBodyAt(text, offset, unit)
{
	const around = lineAround(text, offset);
	const line = text.slice(0, offset).split("\n").length - 1;
	if (around.text.trim() != "")
	{
		return null;
	}
	const { tokens, stack } = analyze(text, line);
	const top = stack[stack.length - 1];
	if (!top || top.kind != "block" || (top.name != "switch" && top.name != "pluto_switch"))
	{
		return null;
	}
	const cases = switchCases(tokens, top.idx, offset);
	return { header: cases.length ? cases[cases.length - 1] : null, cases, tokens, switchEntry: top, line, indent: indentOf(around.text), unit };
}

/** The suggestion of `break` on an empty line in the body of a `case` that does not end with one. */
function caseBreakAt(text, offset)
{
	const body = caseBodyAt(text, offset);
	if (!body || !body.header || body.header.isDefault)
	{
		return null;
	}
	const { header, tokens } = body;
	const headerIndent = indentOf(lineAround(text, header.tok.off).text);
	if (body.indent.length <= headerIndent.length)
	{
		return null; // not inside of the body
	}
	// Something that ends the body is there already.
	for (let k = header.idx + 1; k < tokens.length && tokens[k].off < offset; ++k)
	{
		const t = tokens[k];
		if (isId(t) && (TERMINATORS.has(t.v) || (t.v == "error" && isP(tokens[k + 1], "("))))
		{
			return null;
		}
	}
	// What follows: another `case`, `default`, `end`, or nothing.
	const rest = text.slice(offset).split("\n").map(l => l.trim()).find((l, i) => i > 0 && l);
	if (rest !== undefined && !/^(?:case\b|default\b|end\b)/.test(rest))
	{
		return null;
	}
	return { indent: body.indent };
}

/** `case ` and `default:` on an empty line at the level of the cases of a `switch`. */
function caseWordsAt(text, offset, unit)
{
	const body = caseBodyAt(text, offset, unit);
	if (!body)
	{
		return [];
	}
	const { tokens, switchEntry, cases } = body;
	const switchLine = lineAround(text, tokens[switchEntry.idx].off).text;
	// The level of the cases: that of the ones there are, else one level in from `switch`.
	const level = cases.length ? indentOf(lineAround(text, cases[0].tok.off).text) : indentOf(switchLine) + (body.unit || "    ");
	if (body.indent != level)
	{
		return [];
	}
	const out = [{ kind: "case-word", insert: "case " }];
	if (!cases.some(c => c.isDefault))
	{
		out.push({ kind: "case-word", insert: "default:" });
	}
	return out;
}

/**
 * Cases that run into the next one because nothing ends their body. A case with an empty body is a way to give two
 * cases one body (`case 1: case 2: ...`) and is left alone.
 * @returns {{ line: number, col: number, endCol: number }[]}
 */
function findCaseFallthroughs(text)
{
	const tokens = tokenize(text);
	const out = [];
	const stack = [];
	const isSwitch = (e) => !!e && (e.name == "switch" || e.name == "pluto_switch");
	const finish = function (entry)
	{
		const c = entry.current;
		if (c && c.isCase && !c.terminated && c.body > 0)
		{
			out.push({ line: c.tok.line, col: c.tok.col, endCol: c.tok.col + 4 });
		}
	};
	for (let idx = 0; idx < tokens.length; ++idx)
	{
		const tok = tokens[idx];
		const top = stack[stack.length - 1];
		if (tok.t == "id" && (tok.v == "case" || tok.v == "default") && isSwitch(top) && !isP(tokens[idx - 1], "."))
		{
			finish(top);
			top.current = { tok, isCase: tok.v == "case", terminated: false, body: 0, colonSeen: false };
			continue;
		}
		if (isSwitch(top) && top.current)
		{
			if (!top.current.colonSeen)
			{
				top.current.colonSeen = isP(tok, ":");
			}
			else
			{
				++top.current.body;
			}
		}
		if (tok.t != "id")
		{
			continue;
		}
		const v = tok.v;
		if (TERMINATORS.has(v) || (v == "error" && isP(tokens[idx + 1], "(")))
		{
			// Anything that leaves counts, however deep, for the switches it is in.
			for (const entry of stack)
			{
				if (entry.current)
				{
					entry.current.terminated = true;
				}
			}
			continue;
		}
		if (v == "end" || v == "until")
		{
			for (let k = stack.length - 1; k >= 0; --k)
			{
				if (v == "until" ? stack[k].name == "repeat" : true)
				{
					if (isSwitch(stack[k]))
					{
						// The last case runs into nothing: nothing to report.
						stack[k].current = null;
					}
					stack.length = k;
					break;
				}
			}
		}
		else if (v == "do")
		{
			const t = stack[stack.length - 1];
			if (t && t.needsDo)
			{
				t.needsDo = false;
			}
			else
			{
				stack.push({ name: "do" });
			}
		}
		else if (BLOCK_OPENERS.has(v) && !isP(tokens[idx - 1], "."))
		{
			const afterEnum = (v == "class" || v == "pluto_class") && (isId(tokens[idx - 1], "enum") || isId(tokens[idx - 1], "pluto_enum"));
			if (!afterEnum && !(v == "function" && isFunctionType(tokens, idx)))
			{
				stack.push({ name: v, needsDo: NEEDS_DO.has(v) });
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// A constructor for a class that has none
// ---------------------------------------------------------------------------------------------

/**
 * What a class has at its own level: the names of its methods and what it extends.
 * @returns {{ methods: string[], extends: string|null }}
 */
function classMembers(tokens, classIdx)
{
	const out = { methods: [], extends: null };
	if (isId(tokens[classIdx + 2], "extends") && isId(tokens[classIdx + 3]))
	{
		out.extends = tokens[classIdx + 3].v;
	}
	let depth = 0;
	let pendingDo = 0;
	for (let k = classIdx + 1; k < tokens.length; ++k)
	{
		const t = tokens[k];
		if (t.t != "id")
		{
			continue;
		}
		if (t.v == "end" || t.v == "until")
		{
			if (depth == 0)
			{
				break;
			}
			--depth;
		}
		else if (t.v == "do")
		{
			if (pendingDo > 0)
			{
				--pendingDo;
			}
			else
			{
				++depth;
			}
		}
		else if (BLOCK_OPENERS.has(t.v) && !isP(tokens[k - 1], ".") && !(t.v == "function" && isFunctionType(tokens, k)))
		{
			if (t.v == "function" && depth == 0 && isId(tokens[k + 1]))
			{
				out.methods.push(tokens[k + 1].v);
			}
			++depth;
			if (NEEDS_DO.has(t.v))
			{
				++pendingDo;
			}
		}
	}
	return out;
}

/**
 * A constructor to suggest where a class has none: `function __construct()` on an empty line of the body, or what
 * follows `function` when only that is typed. A class that extends another gets a second one that calls the parent's.
 * @param {string} text
 * @param {number} offset
 * @returns {{ kind: string, insert: string, snippet: string }[]}
 */
function constructorSuggestionsAt(text, offset)
{
	const around = lineAround(text, offset);
	const line = text.slice(0, offset).split("\n").length - 1;
	const before = text.slice(around.start, offset);
	const emptyLine = around.text.trim() == "";
	const afterFunction = /^\s*function$/.test(before) && text.slice(offset, around.end).trim() == "";
	if (!emptyLine && !afterFunction)
	{
		return [];
	}
	// the lone `function` would open a block of its own, so it is blanked out for the analysis
	const source = afterFunction ? text.slice(0, offset - 8) + " ".repeat(8) + text.slice(offset) : text;
	const { tokens, stack } = analyze(source, line);
	const top = stack[stack.length - 1];
	if (!top || top.kind != "block" || (top.name != "class" && top.name != "pluto_class"))
	{
		return [];
	}
	const members = classMembers(tokens, top.idx);
	if (members.methods.includes("__construct"))
	{
		return [];
	}
	if (emptyLine && indentOf(around.text).length <= indentOf(lineAround(text, tokens[top.idx].off).text).length)
	{
		return []; // not inside of the body
	}
	const head = emptyLine ? "function" : "";
	const lead = emptyLine ? "" : " ";
	const out = [{ kind: "ctor", insert: lead + head + (emptyLine ? " " : "") + "__construct()", snippet: lead + head + (emptyLine ? " " : "") + "__construct($1)" }];
	if (members.extends)
	{
		const base = lead + head + (emptyLine ? " " : "") + "__construct";
		out.push({
			kind: "ctor-parent",
			insert: base + "()\n\tparent:__construct()\nend",
			snippet: base + "($1)\n\tparent:__construct($2)\nend",
		});
	}
	return out;
}

/**
 * The suggestions of this module at a place. Those with `paused` wait for the cursor to rest (they would flicker
 * while you type), the others are shown at once.
 * @param {string} text
 * @param {number} offset
 * @param {{ paramType?: boolean, returnType?: boolean, returnValue?: boolean, caseColon?: boolean, caseBreak?: boolean, caseWords?: boolean }} options
 * @param {{ isClass?: (name: string) => boolean, unit?: string }} [extra]
 * @returns {{ kind: string, insert: string, paused: boolean, command?: string }[]}
 */
function suggestionsAt(text, offset, options, extra)
{
	const out = [];
	const isClass = extra && extra.isClass;
	const around = lineAround(text, offset);
	const before = text.slice(around.start, offset);
	const rest = text.slice(offset, around.end);
	const OPEN_TYPES = "editor.action.triggerSuggest";
	if (!inCode(before))
	{
		return out;
	}
	if (options.paramType)
	{
		const p = untypedParamAt(text, offset);
		if (p && offset >= p.nameEnd && text.slice(p.nameEnd, offset).trim() == "" && /^\s*(?:[,)]|$)/.test(rest))
		{
			out.push({ kind: "param-colon", insert: ": ", paused: true, command: OPEN_TYPES });
		}
	}
	if (options.returnType && returnColonAt(text, offset))
	{
		out.push({ kind: "return-colon", insert: ": ", paused: true, command: OPEN_TYPES });
	}
	if (options.caseColon && caseColonAt(text, offset))
	{
		out.push({ kind: "case-colon", insert: ":", paused: true });
	}
	if (options.returnValue)
	{
		const space = /\s$/.test(before) ? "" : " ";
		for (const value of returnValuesAt(text, offset, isClass))
		{
			out.push({ kind: "return-value", insert: space + value, paused: false });
		}
	}
	if (options.caseBreak && caseBreakAt(text, offset))
	{
		out.push({ kind: "case-break", insert: "break", paused: false });
	}
	if (options.caseWords)
	{
		for (const word of caseWordsAt(text, offset, extra && extra.unit))
		{
			out.push({ kind: "case-word", insert: word.insert, paused: false });
		}
	}
	return out;
}

module.exports = {
	untypedParamAt, returnColonAt, returnValuesAt, enclosingReturnType, findReturnProblems, functionHeader,
	caseColonAt, caseNoColonAt, caseBreakAt, caseWordsAt, findCaseFallthroughs, suggestionsAt, classMembers, constructorSuggestionsAt,
};
