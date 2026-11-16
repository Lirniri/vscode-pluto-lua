// Live directives: a line `#<target> = <value>` replaces the value of the target (a variable, a parameter, a field such as
// `self.hp`, or the `return` of the function) and `#<target> >show_up` / `>show_down` look for the target above / below and show
// what was found. The same lines in a comment (`-- #speed >show_up`) stay in the code and are only shown. The `#` and the `>`
// and the names of the commands can be changed (`syntax` of the options). Free of VS Code dependencies so it can be unit-tested.

"use strict";

const { findFunctionShapes } = require("./hints");
const { inferType, applyDirective } = require("./returnHint");
const { codeOf } = require("./autoIndent");
const { t } = require("./i18n");

const DEFAULTS = {
	maxPreviewLength: 60, maxContextLines: 3, maxSearchDistance: 200,
	allowModify: true, skipConst: true, ignoredTargets: [],
	prefix: "#", commandSeparator: ">", commandAliases: {},
};

const COMMANDS = ["show_up", "show_down", "show_all", "type", "sign", "trace", "rename", "const", "unused", "calls"];
/** The commands that change code (the others only look). */
const MODIFY_COMMANDS = ["sign", "const", "rename"];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const IDENT = "[A-Za-z_]\\w*";
const TARGET = "(return|" + IDENT + "(?:[ \\t]*\\.[ \\t]*" + IDENT + ")*)";

/** The prefix, the separator and the aliases of the options, with the defaults for what is missing or not usable. */
function syntaxOf(options)
{
	const o = options || {};
	const usable = (s) => typeof s == "string" && s.length > 0 && !/\s/.test(s);
	const aliases = {};
	if (o.commandAliases && typeof o.commandAliases == "object")
	{
		for (const [name, command] of Object.entries(o.commandAliases))
		{
			if (/^\w+$/.test(name) && COMMANDS.includes(command))
			{
				aliases[name] = command;
			}
		}
	}
	return { prefix: usable(o.prefix) ? o.prefix : DEFAULTS.prefix, separator: usable(o.commandSeparator) ? o.commandSeparator : DEFAULTS.commandSeparator, aliases };
}

const regexCache = new Map();
/** The patterns of a syntax (cached): the whole line, the text before the cursor for a target, and for a command. */
function patternsOf(syntax)
{
	const key = syntax.prefix + "\u0000" + syntax.separator;
	let p = regexCache.get(key);
	if (!p)
	{
		const pre = escapeRe(syntax.prefix);
		const sep = escapeRe(syntax.separator);
		p = {
			// indent, `--`, target, `= value`, value, `> command`, command, value of the command
			line: new RegExp("^([ \\t]*)(--[ \\t]*)?" + pre + "[ \\t]*" + TARGET + "[ \\t]*(?:(=(?!=)[ \\t]*(.*?))|(" + sep + "[ \\t]*(\\w*)(?:[ \\t]*=[ \\t]*(.*?))?))?[ \\t]*$"),
			target: new RegExp("^[ \\t]*(?:--[ \\t]*)?" + pre + "[ \\t]*[\\w.]*$"),
			command: new RegExp("^[ \\t]*(?:--[ \\t]*)?" + pre + "[ \\t]*" + TARGET.replace("(return|", "(?:return|") + "[ \\t]*" + sep + "[ \\t]*\\w*$"),
		};
		regexCache.set(key, p);
	}
	return p;
}

/** The command a word stands for: `show_up` / `show_down`, an alias, or null. */
function resolveCommand(word, syntax)
{
	if (COMMANDS.includes(word))
	{
		return word;
	}
	return Object.prototype.hasOwnProperty.call(syntax.aliases, word) ? syntax.aliases[word] : null;
}

/**
 * The directive a line holds, or null.
 * @param {string} line
 * @param {{ prefix?: string, commandSeparator?: string, commandAliases?: Record<string, string> }} [options]
 * @returns {{ indent: string, comment: boolean, target: string, op: "="|"show_up"|"show_down"|">"|null, expr: string }|null}
 *   `op` is null for a bare `#name` and `">"` for a command that is not finished or not known.
 */
function parseDirective(line, options)
{
	const syntax = syntaxOf(options);
	const m = patternsOf(syntax).line.exec(line.replace(/\r$/, ""));
	if (!m)
	{
		return null;
	}
	let op = null;
	if (m[4] !== undefined)
	{
		op = "=";
	}
	else if (m[6] !== undefined)
	{
		op = resolveCommand(m[7], syntax) || ">";
	}
	return { indent: m[1], comment: !!m[2], target: m[3].replace(/\s+/g, ""), op, expr: (op == "=" ? m[5] : m[8]) || "" };
}

/** A directive that does something: `=` with a value, or a whole `>show_up` / `>show_down`. */
function isActive(d)
{
	return !!d && ((d.op == "=" && d.expr != "") || COMMANDS.includes(d.op));
}

/** A directive that changes code when it is carried out. */
function isModifying(d)
{
	return !!d && (d.op == "=" || MODIFY_COMMANDS.includes(d.op));
}

/** Whether a target is on the list of names to ignore (`*` in a name stands for any characters). */
function isIgnored(target, list)
{
	return (Array.isArray(list) ? list : []).some(function (name)
	{
		if (typeof name != "string" || !name.trim())
		{
			return false;
		}
		const n = name.trim();
		return n.includes("*") ? new RegExp("^" + n.split("*").map(escapeRe).join(".*") + "$").test(target) : n == target;
	});
}

/** The text cut to `max` characters, with `…` when something was left out. */
function truncate(text, max)
{
	const s = String(text).replace(/\s+/g, " ").trim();
	return s.length > max ? s.slice(0, Math.max(1, max - 1)).trimEnd() + "…" : s;
}

/** The target as a pattern: spaces around the dots of `self . hp` are allowed. */
const targetRe = (target) => escapeRe(target).replace(/\\\./g, "\\s*\\.\\s*");

/**
 * `target = value`, with the modifiers, an attribute (`<const>`) and a type in front, and a compound operator before the `=`.
 * Groups: 1 indent, 2 modifier, 3 attribute, 4 type, 5 value.
 */
function assignRe(target)
{
	return new RegExp("^(\\s*)((?:local|const|static)\\s+)?" + targetRe(target) + "(?![\\w.])(?:\\s*<\\s*(const|close)\\s*>)?(\\s*:\\s*[^=]+?)?\\s*(?:\\.\\.|//|<<|>>|[-+*/%^&|])?=(?!=)\\s*(.*)$", "d");
}

const usageRe = (target) => new RegExp("(?<![\\w.])" + targetRe(target) + "(?![\\w])");

const linesOf = (text) => text.split("\n").map(l => l.replace(/\r$/, ""));

/** The innermost function that contains the line. */
function ownerAt(shapes, line)
{
	return shapes.filter(s => s.line <= line && line <= s.endLine).sort((a, b) => b.line - a.line)[0] || null;
}

function typeOfParam(headerText, name)
{
	const m = new RegExp("(?<![\\w.])" + escapeRe(name) + "\\s*:\\s*([^=,)]+)").exec(headerText);
	return m ? m[1].trim() : null;
}

/**
 * What a line says about the target: how it is assigned, and with which value.
 * @returns {{ kind: "declaration"|"assignment", value: string, valueStart: number, valueEnd: number, type: string|null, constant: boolean }|null}
 */
function assignmentIn(line, target)
{
	const masked = codeOf(line);
	const m = assignRe(target).exec(masked);
	if (!m)
	{
		return null;
	}
	const [start, end] = m.indices[5];
	const value = line.slice(start, end).trim();
	const annotation = m[4] ? m[4].replace(/^\s*:\s*/, "").trim() : null;
	return {
		kind: m[2] ? "declaration" : "assignment", value, valueStart: start, valueEnd: start + line.slice(start, end).replace(/\s+$/, "").length,
		type: annotation || (value ? inferType(value) : null), constant: (m[2] || "").trim() == "const" || m[3] == "const",
	};
}

/**
 * The nearest place above `dirLine` that declares, assigns or (for `return`) returns the target.
 * @param {string} text
 * @param {number} dirLine
 * @param {string} target
 * @param {typeof DEFAULTS} [opts]
 * @returns {{ line: number, kind: string, text: string, value: string, type: string|null, valueStart?: number, valueEnd?: number, param?: string, constant?: boolean }|null}
 */
function findAbove(text, dirLine, target, opts)
{
	const o = Object.assign({}, DEFAULTS, opts);
	const max = o.maxSearchDistance;
	const lines = linesOf(text);
	const shapes = findFunctionShapes(text);
	const owner = ownerAt(shapes, dirLine);
	if (target == "return")
	{
		const ret = owner ? owner.returns.filter(r => r.line < dirLine && dirLine - r.line <= max).sort((a, b) => b.line - a.line)[0] : null;
		if (!ret)
		{
			return null;
		}
		const value = ret.bare ? "" : text.slice(ret.valueStart, ret.valueEnd).trim();
		return { line: ret.line, kind: "return", text: lines[ret.line].trim(), value, type: value ? inferType(value) : null };
	}
	const enclosing = shapes.filter(s => s.line <= dirLine && dirLine <= s.endLine).sort((a, b) => b.line - a.line);
	for (let i = dirLine - 1; i >= 0 && dirLine - i <= max; --i)
	{
		if (isActive(parseDirective(lines[i], o)))
		{
			continue;
		}
		const a = assignmentIn(lines[i], target);
		if (a && (!o.onlyDeclaration || a.kind == "declaration"))
		{
			return Object.assign({ line: i, text: lines[i].trim() }, a);
		}
		if (!target.includes("."))
		{
			for (const fn of enclosing)
			{
				const p = fn.params.find(x => x.name == target && x.line == i);
				if (p)
				{
					const def = new RegExp("(?<![\\w.])" + escapeRe(target) + "\\s*(?::\\s*[^=,)]+?)?\\s*=\\s*([^,)]+)").exec(lines[i]);
					const value = def ? def[1].trim() : "";
					return { line: i, kind: "parameter", text: lines[i].trim(), value, type: typeOfParam(lines[i], target) || (value ? inferType(value) : null), param: target };
				}
			}
		}
	}
	return null;
}

/**
 * The nearest place below `dirLine` that changes or uses the target (for `return`: the next `return`; else the last one of the
 * function when nothing else is found).
 */
function findBelow(text, dirLine, target, opts)
{
	const o = Object.assign({}, DEFAULTS, opts);
	const max = o.maxSearchDistance;
	const lines = linesOf(text);
	const shapes = findFunctionShapes(text);
	const owner = ownerAt(shapes, dirLine);
	const returns = owner ? owner.returns.filter(r => r.line > dirLine && r.line - dirLine <= max).sort((a, b) => a.line - b.line) : [];
	const asReturn = (ret) =>
	{
		const value = ret.bare ? "" : text.slice(ret.valueStart, ret.valueEnd).trim();
		return { line: ret.line, kind: "return", text: lines[ret.line].trim(), value, type: value ? inferType(value) : null };
	};
	if (target == "return")
	{
		return returns.length ? asReturn(returns[0]) : null;
	}
	const last = owner ? Math.min(lines.length - 1, owner.endLine, dirLine + max) : Math.min(lines.length - 1, dirLine + max);
	const use = usageRe(target);
	for (let i = dirLine + 1; i <= last; ++i)
	{
		if (isActive(parseDirective(lines[i], o)))
		{
			continue;
		}
		const code = codeOf(lines[i]);
		if (!use.test(code))
		{
			continue;
		}
		const a = assignmentIn(lines[i], target);
		return a ? Object.assign({ line: i, text: lines[i].trim() }, a) : { line: i, kind: "use", text: lines[i].trim(), value: "", type: null };
	}
	return returns.length ? asReturn(returns[returns.length - 1]) : null;
}

/** The type of a found place, as a suffix for the preview: `, тип float`. */
const typeSuffix = (found) => (found.type ? t("liveDir.typeSuffix", found.type) : "");

/** A line with the value of the found place replaced (a parameter: its default). */
function replaceIn(lineText, found, dir)
{
	if (found.kind == "parameter")
	{
		const re = new RegExp("(?<![\\w.])(" + escapeRe(found.param) + ")(\\s*:\\s*[^=,)]+?)?(\\s*=\\s*[^,)]*)?(?=\\s*[,)])");
		const m = re.exec(lineText);
		if (!m)
		{
			return null;
		}
		return lineText.slice(0, m.index) + m[1] + (m[2] || "") + " = " + dir.expr + lineText.slice(m.index + m[0].length);
	}
	if (found.valueStart === undefined)
	{
		return null;
	}
	return lineText.slice(0, found.valueStart) + dir.expr + lineText.slice(found.valueEnd);
}

/**
 * Carries out `#target = value`: the directive line goes, the value of the target is replaced (for `return`: the `return` at the
 * end of the function is made or replaced).
 * @param {string} text Text with LF breaks.
 * @returns {{ text: string|null, reason: "ok"|"readOnly"|"ignored"|"const"|"notFound" }}
 */
function assignResult(text, line, dir, unit, eol, options)
{
	const o = Object.assign({}, DEFAULTS, options);
	if (!o.allowModify)
	{
		return { text: null, reason: "readOnly" };
	}
	if (isIgnored(dir.target, o.ignoredTargets))
	{
		return { text: null, reason: "ignored" };
	}
	if (dir.target == "return")
	{
		const next = applyDirective(text, { line, expr: dir.expr }, unit, eol);
		return { text: next, reason: next === null ? "notFound" : "ok" };
	}
	const found = findAbove(text, line, dir.target, o);
	if (!found || found.kind == "return")
	{
		return { text: null, reason: "notFound" };
	}
	if (found.constant && o.skipConst)
	{
		return { text: null, reason: "const" };
	}
	const lines = text.split("\n");
	const replaced = replaceIn(lines[found.line].replace(/\r$/, ""), found, dir);
	if (replaced === null)
	{
		return { text: null, reason: "notFound" };
	}
	lines[found.line] = replaced + (lines[found.line].endsWith("\r") ? "\r" : "");
	lines.splice(line, 1);
	return { text: lines.join("\n"), reason: "ok" };
}

/** `assignResult` that gives only the new text (null when nothing is to be changed). */
function assign(text, line, dir, unit, eol, options)
{
	return assignResult(text, line, dir, unit, eol, options).text;
}

/**
 * What the grey note and the hover of a directive show.
 * @param {string} text
 * @param {number} line The line of the directive.
 * @param {ReturnType<typeof parseDirective>} dir
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{ preview: string, found: ReturnType<typeof findAbove>, context: { start: number, lines: string[], found: number }|null }|null}
 */
function previewFor(text, line, dir, options)
{
	const o = Object.assign({}, DEFAULTS, options);
	if (!dir || !dir.op || dir.op == ">" || isIgnored(dir.target, o.ignoredTargets))
	{
		return null;
	}
	if (dir.op != "=" && dir.op != "show_up" && dir.op != "show_down")
	{
		return commandPreview(text, line, dir, o);
	}
	const lines = linesOf(text);
	const cut = (s) => truncate(s, o.maxPreviewLength);
	const contextOf = (found) =>
	{
		if (!found)
		{
			return null;
		}
		const total = Math.max(1, o.maxContextLines);
		const before = Math.floor((total - 1) / 2);
		const start = Math.max(0, found.line - before);
		const end = Math.min(lines.length - 1, start + total - 1);
		return { start, lines: lines.slice(start, end + 1), found: found.line };
	};
	if (dir.op == "show_up" || dir.op == "show_down")
	{
		const up = dir.op == "show_up";
		const found = (up ? findAbove : findBelow)(text, line, dir.target, o);
		return {
			found, context: contextOf(found),
			preview: found ? t(up ? "liveDir.above" : "liveDir.below", cut(found.text), found.line + 1, typeSuffix(found)) : t("liveDir.notFound", dir.target, o.maxSearchDistance),
		};
	}
	// `=`
	const above = findAbove(text, line, dir.target, o);
	if (dir.expr == "")
	{
		return { found: above, context: contextOf(above), preview: above ? t("liveDir.current", cut(above.text), above.line + 1) : t("liveDir.notFound", dir.target, o.maxSearchDistance) };
	}
	if (!o.allowModify)
	{
		return { found: above, context: contextOf(above), preview: t("liveDir.readOnly") };
	}
	if (dir.target == "return")
	{
		const shapes = findFunctionShapes(text);
		if (!ownerAt(shapes, line))
		{
			return { found: null, context: null, preview: t("liveDir.noFunction") };
		}
		const result = assignResult(text, line, dir, "    ", "\n", o);
		return { found: above, context: contextOf(above), preview: above && result.text ? t("liveDir.replaceReturn", cut("return " + dir.expr), above.line + 1) : t("liveDir.createReturn", cut(dir.expr)) };
	}
	if (!above)
	{
		return { found: null, context: null, preview: t("liveDir.notFound", dir.target, o.maxSearchDistance) };
	}
	if (above.constant && o.skipConst)
	{
		return { found: above, context: contextOf(above), preview: t("liveDir.const", dir.target, above.line + 1) };
	}
	const replaced = replaceIn(lines[above.line], above, dir);
	return { found: above, context: contextOf(above), preview: t("liveDir.replace", cut(replaced === null ? above.text : replaced.trim()), above.line + 1) };
}

/** The names that can be a target at a line: the parameters of the functions around, the locals above and the `self.` fields. */
function namesInScope(text, line, options)
{
	const o = Object.assign({}, DEFAULTS, options);
	const max = o.maxSearchDistance;
	const lines = linesOf(text);
	const out = [];
	const seen = new Set();
	const add = (label, kind, detail) =>
	{
		if (!seen.has(label) && !isIgnored(label, o.ignoredTargets))
		{
			seen.add(label);
			out.push({ label, kind, detail });
		}
	};
	const shapes = findFunctionShapes(text);
	for (const fn of shapes.filter(s => s.line <= line && line <= s.endLine).sort((a, b) => b.line - a.line))
	{
		fn.params.forEach(p => add(p.name, "parameter", t("liveDir.item.parameter")));
	}
	for (let i = line - 1; i >= 0 && line - i <= max; --i)
	{
		const code = codeOf(lines[i]);
		const local = /^\s*local\s+(?:function\s+)?([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/.exec(code);
		if (local)
		{
			local[1].split(",").forEach(n => add(n.trim(), "variable", t("liveDir.item.local")));
		}
		const loop = /^\s*for\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+(?:in\b|=)/.exec(code);
		if (loop)
		{
			loop[1].split(",").forEach(n => add(n.trim(), "variable", t("liveDir.item.local")));
		}
	}
	const field = /(?<![\w.])self\.([A-Za-z_]\w*)/g;
	let m;
	while ((m = field.exec(text)) !== null)
	{
		add("self." + m[1], "field", t("liveDir.item.field"));
	}
	return out;
}

/**
 * The completion items for the text before the cursor at `(line, col)`.
 * @returns {{ label: string, kind: string, detail: string, documentation?: string }[]}
 */
function completionsFor(text, line, col, options)
{
	const syntax = syntaxOf(options);
	const patterns = patternsOf(syntax);
	const prefix = (linesOf(text)[line] || "").slice(0, col);
	if (patterns.command.test(prefix))
	{
		const items = COMMANDS.map(c => ({ label: c, kind: "command", detail: t("liveDir.cmd." + c), documentation: t("liveDir.cmdDoc." + c) }));
		for (const [alias, command] of Object.entries(syntax.aliases))
		{
			items.push({ label: alias, kind: "command", detail: t("liveDir.cmd." + command), documentation: t("liveDir.cmdDoc." + command) });
		}
		return items;
	}
	if (patterns.target.test(prefix))
	{
		return [{ label: "return", kind: "keyword", detail: t("liveDir.item.return") }].filter(i => !isIgnored(i.label, (options || {}).ignoredTargets)).concat(namesInScope(text, line, options));
	}
	return [];
}


// ---------------------------------------------------------------------------------------------
// The commands that look around: show_all, type, trace, unused, calls; and the ones that change code: sign, const, rename
// ---------------------------------------------------------------------------------------------

const KEYWORDS = new Set(["and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in", "local", "nil", "not", "or",
	"repeat", "return", "then", "true", "until", "while", "continue", "switch", "case", "default", "class", "new", "self", "const", "static"]);

/** The lines a command looks at: the function around the directive (for `self.` fields and outside of functions: the file). */
function scopeRange(text, line, target, opts)
{
	const o = Object.assign({}, DEFAULTS, opts);
	const lines = linesOf(text);
	const owner = ownerAt(findFunctionShapes(text), line);
	let from = 0;
	let to = lines.length - 1;
	if (owner && !target.startsWith("self."))
	{
		from = owner.line;
		to = owner.endLine;
	}
	return { from: Math.max(from, line - o.maxSearchDistance), to: Math.min(to, line + o.maxSearchDistance), owner, lines };
}

/** Whether the match at `index` of a masked line is the key of a table constructor (`{ acc = 1 }`), which is a field, not the name. */
function isTableKey(code, index, length)
{
	const before = code.slice(0, index);
	const opened = (before.match(/\{/g) || []).length - (before.match(/\}/g) || []).length;
	const next = code.slice(index + length).replace(/^\s+/, "");
	return opened > 0 && /[{,]\s*$/.test(before) && /^=(?!=)/.test(next);
}

/** Whether the line uses the name other than as a key of a table constructor. */
function usesName(code, target)
{
	const re = new RegExp(usageRe(target).source, "g");
	let m;
	while ((m = re.exec(code)) !== null)
	{
		if (target.startsWith("self.") || !isTableKey(code, m.index, m[0].length))
		{
			return true;
		}
	}
	return false;
}

/** Every place of the target in its scope: `{ line, kind, text }`. */
function findPlaces(text, line, target, opts)
{
	const o = Object.assign({}, DEFAULTS, opts);
	const { from, to, owner, lines } = scopeRange(text, line, target, o);
	const places = [];
	if (target == "return")
	{
		for (const r of owner ? owner.returns : [])
		{
			if (r.line >= from && r.line <= to)
			{
				places.push({ line: r.line, kind: "return", text: lines[r.line].trim() });
			}
		}
		return places;
	}
	const use = usageRe(target);
	const enclosing = findFunctionShapes(text).filter(s => s.line <= line && line <= s.endLine);
	for (let i = from; i <= to; ++i)
	{
		if (isActive(parseDirective(lines[i], o)))
		{
			continue;
		}
		const code = codeOf(lines[i]);
		if (!use.test(code) || !usesName(code, target))
		{
			continue;
		}
		const a = assignmentIn(lines[i], target);
		let kind = a ? a.kind : "use";
		if (!a && !target.includes(".") && enclosing.some(fn => fn.params.some(p => p.name == target && p.line == i)))
		{
			kind = "parameter";
		}
		else if (!a && /^\s*return\b/.test(code))
		{
			kind = "return";
		}
		places.push({ line: i, kind, text: lines[i].trim() });
		if (places.length >= 60)
		{
			break;
		}
	}
	return places;
}

/** The type of the target and where it comes from. `{ type, source }`: source is `found`, `returns` or null. */
function typeInfo(text, line, target, opts)
{
	const o = Object.assign({}, DEFAULTS, opts);
	if (target == "return")
	{
		const owner = ownerAt(findFunctionShapes(text), line);
		const valued = owner ? owner.returns.filter(r => !r.bare) : [];
		if (!valued.length)
		{
			return { type: null, returns: [] };
		}
		const types = [];
		let known = true;
		for (const r of valued)
		{
			const ty = inferType(text.slice(r.valueStart, r.valueEnd));
			if (!ty)
			{
				known = false;
			}
			else if (!types.includes(ty))
			{
				types.push(ty);
			}
		}
		return { type: known ? types.join("|") : null, returns: valued.map(r => r.line) };
	}
	const found = findAbove(text, line, target, o);
	if (found && !found.type && found.kind != "declaration")
	{
		const declaration = findAbove(text, line, target, Object.assign({}, o, { onlyDeclaration: true }));
		if (declaration && declaration.type)
		{
			return { type: declaration.type, found: declaration };
		}
	}
	return { type: found ? found.type : null, found };
}

/** The identifiers of an expression that name something (no keywords, no numbers). */
function identsOf(expr)
{
	const out = [];
	const re = /(?<![\w.])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g;
	let m;
	while ((m = re.exec(codeOf(expr))) !== null)
	{
		const root = m[1].split(".")[0];
		if (!(KEYWORDS.has(root) && root != "self") && !out.includes(m[1]))
		{
			out.push(m[1]);
		}
	}
	return out;
}

/** How the value of the target is made: up to 3 steps, each the place that sets a name that the step before uses. */
function traceChain(text, line, target, opts)
{
	const o = Object.assign({}, DEFAULTS, opts);
	const steps = [];
	let name = target;
	let from = line;
	for (let n = 0; n < 3; ++n)
	{
		const found = findAbove(text, from, name, o) || (n == 0 && name == "return" ? findBelow(text, from, name, o) : null);
		if (!found)
		{
			break;
		}
		steps.push({ name, line: found.line, text: found.text, kind: found.kind, value: found.value });
		if (found.kind == "parameter" || !found.value)
		{
			break;
		}
		const next = identsOf(found.value).find(id => id != name && findAbove(text, found.line, id, o)) || identsOf(found.value).find(id => findAbove(text, found.line, id, o));
		if (!next)
		{
			break;
		}
		name = next;
		from = found.line;
	}
	return steps;
}

/** The place that names a function in a call: `Car:update`, `update` or `(file)`. */
function contextName(lines, shapes, line)
{
	const owner = ownerAt(shapes, line);
	if (!owner)
	{
		return "";
	}
	const indent = (/^\s*/.exec(lines[owner.line])[0] || "").length;
	let cls = "";
	for (let i = owner.line - 1; i >= 0; --i)
	{
		const m = /^(\s*)(?:(?:export|local|public|private|protected)\s+)*(?:class|pluto_class)\s+([A-Za-z_]\w*)/.exec(lines[i]);
		if (m && m[1].length < indent)
		{
			cls = m[2];
			break;
		}
	}
	const name = owner.name || "?";
	return cls && !name.includes(":") && !name.includes(".") ? cls + ":" + name : name;
}

/** The calls of a function in the file: `{ line, text, where }`. */
function findCalls(text, line, name, opts)
{
	const o = Object.assign({}, DEFAULTS, opts);
	const lines = linesOf(text);
	const shapes = findFunctionShapes(text);
	const call = new RegExp("(?<![\\w])" + escapeRe(name) + "\\s*\\(");
	const definition = new RegExp("\\bfunction\\b[^(]*(?<![\\w])" + escapeRe(name) + "\\s*\\(");
	const out = [];
	for (let i = Math.max(0, line - o.maxSearchDistance); i < lines.length && i <= line + o.maxSearchDistance; ++i)
	{
		if (isActive(parseDirective(lines[i], o)))
		{
			continue;
		}
		const code = codeOf(lines[i]);
		if (call.test(code) && !definition.test(code))
		{
			out.push({ line: i, text: lines[i].trim(), where: contextName(lines, shapes, i) });
		}
		if (out.length >= 60)
		{
			break;
		}
	}
	return out;
}

/** What `unused` finds: the declaration and the places that read the name after it. */
function unusedInfo(text, line, target, opts)
{
	const o = Object.assign({}, DEFAULTS, opts);
	const found = findAbove(text, line, target, Object.assign({}, o, { onlyDeclaration: true }));
	if (!found || found.kind != "declaration")
	{
		return { declaration: null, uses: [] };
	}
	// An assignment that only sets the value is no reading; one that reads the name (`x = x + 1`) is.
	const uses = findPlaces(text, line, target, o)
		.filter(p => p.line > found.line)
		.filter(p => p.kind == "use" || p.kind == "return" || (p.kind == "assignment" && readsItself(p.text, target)));
	return { declaration: found, uses };
}

/** An assignment that reads the name on its right side. */
function readsItself(lineText, target)
{
	const a = assignmentIn(lineText, target);
	return !!a && usageRe(target).test(codeOf(a.value));
}

/** The parts of a declaration line: where the name ends and where its type ends. */
function declParts(lineText, target)
{
	const m = assignRe(target).exec(codeOf(lineText));
	if (!m)
	{
		return null;
	}
	const nameStart = m.indices[2] ? m.indices[2][1] : m.indices[1][1];
	const nameEnd = nameStart + target.length;
	return { nameEnd, annotationEnd: m.indices[4] ? m.indices[4][1] : nameEnd, annotated: !!m[4], hasAttr: !!m[3], modifier: (m[2] || "").trim() };
}

const IDENT_NAME = /^[A-Za-z_]\w*$/;

/** The text with the directive line taken out. */
function withoutLine(lines, line)
{
	const copy = lines.slice();
	copy.splice(line, 1);
	return copy.join("\n");
}

/**
 * Plans the renaming of the target: the new text, or why not.
 * @returns {{ text: string|null, count: number, reason: string, scope?: string }}
 */
function renamePlan(text, line, target, newName, opts)
{
	const o = Object.assign({}, DEFAULTS, opts);
	if (target == "return")
	{
		return { text: null, count: 0, reason: "badTarget" };
	}
	const field = target.startsWith("self.");
	const bare = String(newName || "").trim().replace(/^self\./, "");
	if (!IDENT_NAME.test(bare) || KEYWORDS.has(bare))
	{
		return { text: null, count: 0, reason: String(newName || "").trim() ? "badName" : "needName" };
	}
	const replacement = field ? "self." + bare : bare;
	// The whole scope is renamed, not only the part near the directive.
	const { from, to, owner, lines } = scopeRange(text, line, target, { maxSearchDistance: 1e9 });
	const re = new RegExp("(?<![\\w.])" + targetRe(target) + "(?![\\w])", "g");
	const taken = new RegExp("(?<![\\w.])" + targetRe(replacement) + "(?![\\w])");
	let count = 0;
	const out = lines.slice();
	for (let i = from; i <= to; ++i)
	{
		if (i == line || isActive(parseDirective(lines[i], o)))
		{
			continue;
		}
		const code = codeOf(lines[i]);
		if (taken.test(code))
		{
			return { text: null, count: 0, reason: "taken", scope: owner ? owner.name : "" };
		}
		let result = "";
		let last = 0;
		let m;
		re.lastIndex = 0;
		while ((m = re.exec(code)) !== null)
		{
			// A key of a table constructor (`{ acc = 1 }`) is a field, not the variable.
			if (!field && isTableKey(code, m.index, m[0].length))
			{
				continue;
			}
			result += lines[i].slice(last, m.index) + replacement;
			last = m.index + m[0].length;
			++count;
		}
		out[i] = result + lines[i].slice(last);
	}
	if (!count)
	{
		return { text: null, count: 0, reason: "notFound" };
	}
	return { text: withoutLine(out, line), count, reason: "ok", scope: owner && !field ? owner.name : "" };
}

/** Plans `>const`: `<const>` after the declaration, when nothing sets the name again. */
function constPlan(text, line, target, opts)
{
	const o = Object.assign({}, DEFAULTS, opts);
	if (target == "return" || target.includes("."))
	{
		return { text: null, reason: "badTarget" };
	}
	const found = findAbove(text, line, target, Object.assign({}, o, { onlyDeclaration: true }));
	if (!found || found.kind != "declaration")
	{
		return { text: null, reason: "notFound" };
	}
	if (found.constant)
	{
		return { text: null, reason: "already", found };
	}
	const { to, lines } = scopeRange(text, line, target, { maxSearchDistance: 1e9 });
	for (let i = found.line + 1; i <= to; ++i)
	{
		if (i != line && !isActive(parseDirective(lines[i], o)) && usageRe(target).test(codeOf(lines[i])))
		{
			const a = assignmentIn(lines[i], target);
			if (a && a.kind == "assignment")
			{
				return { text: null, reason: "changed", line: i, found };
			}
		}
	}
	const parts = declParts(lines[found.line], target);
	if (!parts)
	{
		return { text: null, reason: "notFound" };
	}
	const copy = lines.slice();
	copy[found.line] = lines[found.line].slice(0, parts.annotationEnd) + " <const>" + lines[found.line].slice(parts.annotationEnd);
	return { text: withoutLine(copy, line), reason: "ok", found, newLine: copy[found.line].trim() };
}

/** Plans `>sign`: the type of the return in the header of the function, or the type of a variable at its declaration. */
function signPlan(text, line, target, opts)
{
	const o = Object.assign({}, DEFAULTS, opts);
	const lines = linesOf(text);
	if (target == "return")
	{
		const owner = ownerAt(findFunctionShapes(text), line);
		if (!owner)
		{
			return { text: null, reason: "noFunction" };
		}
		if (owner.hasColon || owner.retType)
		{
			return { text: null, reason: "exists", type: owner.retType || "" };
		}
		const info = typeInfo(text, line, "return", o);
		if (!info.returns.length)
		{
			return { text: null, reason: "noReturn" };
		}
		if (!info.type)
		{
			return { text: null, reason: "unknown" };
		}
		const header = lines[owner.closeLine];
		const column = owner.closeEnd - lines.slice(0, owner.closeLine).reduce((sum, l) => sum + l.length + 1, 0);
		const copy = lines.slice();
		copy[owner.closeLine] = header.slice(0, column) + ": " + info.type + header.slice(column);
		return { text: withoutLine(copy, line), reason: "ok", type: info.type, newLine: copy[owner.closeLine].trim() };
	}
	const found = findAbove(text, line, target, Object.assign({}, o, { onlyDeclaration: true }));
	if (!found || found.kind != "declaration")
	{
		return { text: null, reason: "notFound" };
	}
	const parts = declParts(lines[found.line], target);
	if (!parts)
	{
		return { text: null, reason: "notFound" };
	}
	if (parts.annotated)
	{
		return { text: null, reason: "exists", type: found.type || "" };
	}
	if (!found.type)
	{
		return { text: null, reason: "unknown" };
	}
	const copy = lines.slice();
	copy[found.line] = lines[found.line].slice(0, parts.nameEnd) + ": " + found.type + lines[found.line].slice(parts.nameEnd);
	return { text: withoutLine(copy, line), reason: "ok", type: found.type, newLine: copy[found.line].trim() };
}

/** Carries out a directive that changes code. @returns {{ text: string|null, reason: string }} */
function applyDirectiveCommand(text, line, dir, unit, eol, options)
{
	const o = Object.assign({}, DEFAULTS, options);
	if (!isModifying(dir))
	{
		return { text: null, reason: "view" };
	}
	if (!o.allowModify)
	{
		return { text: null, reason: "readOnly" };
	}
	if (isIgnored(dir.target, o.ignoredTargets))
	{
		return { text: null, reason: "ignored" };
	}
	switch (dir.op)
	{
		case "=":
			return assignResult(text, line, dir, unit, eol, o);
		case "rename":
		{
			const found = findAbove(text, line, dir.target, o);
			if (found && found.constant && o.skipConst)
			{
				return { text: null, reason: "const" };
			}
			const plan = renamePlan(text, line, dir.target, dir.expr, o);
			return { text: plan.text, reason: plan.reason };
		}
		case "const":
		{
			const plan = constPlan(text, line, dir.target, o);
			return { text: plan.text, reason: plan.reason };
		}
		case "sign":
		{
			const plan = signPlan(text, line, dir.target, o);
			return { text: plan.text, reason: plan.reason };
		}
		default:
			return { text: null, reason: "view" };
	}
}

const kindWord = (kind) => t("liveDir.kind." + kind);

/** The preview of the commands other than `=` and show_up / show_down. */
function commandPreview(text, line, dir, o)
{
	const lines = linesOf(text);
	const cut = (s) => truncate(s, o.maxPreviewLength);
	const base = { found: null, context: null, places: null, steps: null, declaration: null };
	const readOnly = isModifying(dir) && !o.allowModify;
	if (readOnly)
	{
		return Object.assign(base, { preview: t("liveDir.readOnly") });
	}
	const contextOf = (n) =>
	{
		const total = Math.max(1, o.maxContextLines);
		const before = Math.floor((total - 1) / 2);
		const start = Math.max(0, n - before);
		return { start, lines: lines.slice(start, Math.min(lines.length - 1, start + total - 1) + 1), found: n };
	};
	switch (dir.op)
	{
		case "show_all":
		{
			const places = findPlaces(text, line, dir.target, o);
			if (!places.length)
			{
				return Object.assign(base, { preview: t("liveDir.notFound", dir.target, o.maxSearchDistance) });
			}
			const list = places.map(p => t("liveDir.placeShort", p.line + 1, kindWord(p.kind))).join(", ");
			return Object.assign(base, { places, found: places[0], context: contextOf(places[0].line), preview: cut(t("liveDir.all", places.length, list)) });
		}
		case "type":
		{
			const info = typeInfo(text, line, dir.target, o);
			if (dir.target == "return")
			{
				if (!info.returns.length)
				{
					return Object.assign(base, { preview: t("liveDir.notFound", dir.target, o.maxSearchDistance) });
				}
				const where = info.returns.map(n => n + 1).join(", ");
				return Object.assign(base, { found: { line: info.returns[0] }, context: contextOf(info.returns[0]), places: info.returns.map(n => ({ line: n, kind: "return", text: lines[n].trim() })),
					preview: info.type ? cut(t("liveDir.type", info.type, t("liveDir.typeReturns", info.returns.length, where))) : cut(t("liveDir.typeUnknown", t("liveDir.typeReturns", info.returns.length, where))) });
			}
			if (!info.found)
			{
				return Object.assign(base, { preview: t("liveDir.notFound", dir.target, o.maxSearchDistance) });
			}
			const from = t("liveDir.typeFrom", cut(info.found.text), info.found.line + 1);
			return Object.assign(base, { found: info.found, context: contextOf(info.found.line), preview: info.type ? t("liveDir.type", info.type, from) : t("liveDir.typeUnknown", from) });
		}
		case "trace":
		{
			const steps = traceChain(text, line, dir.target, o);
			if (!steps.length)
			{
				return Object.assign(base, { preview: t("liveDir.notFound", dir.target, o.maxSearchDistance) });
			}
			return Object.assign(base, { steps, found: steps[0], context: contextOf(steps[0].line), preview: cut(steps.map(s => t("liveDir.traceStep", s.text, s.line + 1)).join(" ← ")) });
		}
		case "calls":
		{
			const calls = findCalls(text, line, dir.target, o);
			if (!calls.length)
			{
				return Object.assign(base, { preview: t("liveDir.noCalls", dir.target) });
			}
			const list = calls.map(c => c.where ? t("liveDir.callShort", c.line + 1, c.where) : String(c.line + 1)).join(", ");
			return Object.assign(base, { places: calls.map(c => ({ line: c.line, kind: "call", text: c.text, where: c.where })), found: calls[0], context: contextOf(calls[0].line), preview: cut(t("liveDir.calls", calls.length, list)) });
		}
		case "unused":
		{
			const info = unusedInfo(text, line, dir.target, o);
			if (!info.declaration)
			{
				return Object.assign(base, { preview: t("liveDir.notFound", dir.target, o.maxSearchDistance) });
			}
			if (!info.uses.length)
			{
				return Object.assign(base, { found: info.declaration, declaration: info.declaration, context: contextOf(info.declaration.line), preview: t("liveDir.unused", info.declaration.line + 1) });
			}
			return Object.assign(base, { found: info.declaration, context: contextOf(info.declaration.line), places: info.uses, preview: t("liveDir.used", info.uses.length, info.uses[0].line + 1) });
		}
		case "sign":
		{
			const plan = signPlan(text, line, dir.target, o);
			if (plan.reason != "ok")
			{
				return Object.assign(base, { preview: t("liveDir.sign." + plan.reason, plan.type || "") });
			}
			return Object.assign(base, { preview: t("liveDir.sign", plan.type, cut(plan.newLine)) });
		}
		case "const":
		{
			const plan = constPlan(text, line, dir.target, o);
			if (plan.reason == "ok")
			{
				return Object.assign(base, { found: plan.found, context: contextOf(plan.found.line), preview: t("liveDir.constAdd", cut(plan.newLine)) });
			}
			return Object.assign(base, { found: plan.found || null, context: plan.found ? contextOf(plan.found.line) : null,
				preview: t("liveDir.const." + plan.reason, dir.target, plan.line !== undefined ? plan.line + 1 : "") });
		}
		case "rename":
		{
			const found = findAbove(text, line, dir.target, o);
			if (found && found.constant && o.skipConst)
			{
				return Object.assign(base, { found, context: contextOf(found.line), preview: t("liveDir.const", dir.target, found.line + 1) });
			}
			const plan = renamePlan(text, line, dir.target, dir.expr, o);
			if (plan.reason != "ok")
			{
				return Object.assign(base, { preview: t("liveDir.rename." + plan.reason, dir.expr, dir.target) });
			}
			return Object.assign(base, { preview: t("liveDir.rename", plan.count, dir.target, dir.expr.replace(/^self\./, ""), plan.scope || t("liveDir.inFile")) });
		}
		default:
			return null;
	}
}

module.exports = {
	DEFAULTS, COMMANDS, syntaxOf, resolveCommand, parseDirective, isActive, isIgnored, truncate, findAbove, findBelow, previewFor, replaceIn,
	assign, assignResult, namesInScope, completionsFor, ownerAt, MODIFY_COMMANDS, isModifying, scopeRange, findPlaces, typeInfo, traceChain, findCalls,
	unusedInfo, renamePlan, constPlan, signPlan, applyDirectiveCommand, commandPreview, contextName,
};
