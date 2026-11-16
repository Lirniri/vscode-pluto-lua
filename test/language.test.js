// Tests for the language features (parser, workspace index, providers).
// Runs under plain Node with a mocked "vscode" module: node test/language.test.js

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const vscode = require("./vscode-mock");
const originalLoad = Module._load;
Module._load = function (request, ...rest)
{
	return request == "vscode" ? vscode : originalLoad.call(this, request, ...rest);
};

const { parse, formatSignature, computeFolding } = require("../src/parser");
const { WorkspaceIndex } = require("../src/workspaceIndex");
const { Analyzer, findCall, chainAt, chainBefore, typeAnnotationAt } = require("../src/analysis");
const builtins = require("../src/builtins");
const { createProviders } = require("../src/providers");
const { closerFor } = require("../src/extension");

let failed = 0;
let passed = 0;
function test(name, fn)
{
	try
	{
		fn();
		++passed;
	}
	catch (e)
	{
		++failed;
		console.log("FAIL: " + name + "\n" + (e.stack || e));
	}
}

// ---------------------------------------------------------------------------------------------
// Fixture workspace
// ---------------------------------------------------------------------------------------------

const FILES = {
	"/ws/lib/animal.pluto": [
		"class Animal",
		"    legs = 4",
		"    function speak(sound: string)",
		"        print(sound)",
		"    end",
		"end",
	].join("\n"),
	"/ws/lib/human.pluto": [
		"-- A human being.",
		"-- Walks upright.",
		"class Human extends Animal",
		"    public name: string",
		"    static count = 0",
		"",
		"    --- Creates a human.",
		"    function __construct(name: string, age: number = 3)",
		"        self.name = name",
		"        self.age = age",
		"    end",
		"",
		"    -- Returns the name.",
		"    function getName(): string",
		"        return self.name",
		"    end",
		"",
		"    static function create(name: string, age?: number): Human",
		"        return new Human(name, age)",
		"    end",
		"end",
		"",
		"enum Color begin",
		"    RED,",
		"    GREEN = 5",
		"end",
		"",
		"--- Greets someone.",
		"function greet(who: string, loud?: bool): string",
		"    return \"hi \" .. who",
		"end",
	].join("\n"),
	"/ws/lib/util.lua": [
		"local M = {}",
		"--- Adds two numbers.",
		"function M.add(a, b) return a + b end",
		"function M:method(x) end",
		"M.version = 3",
		"local function hidden() end",
		"return M",
	].join("\n"),
	"/ws/mods/chat/init.pluto": "export function send(text: string) end\n",
};

const index = new WorkspaceIndex();
const analyzer = new Analyzer(index);
for (const [p, text] of Object.entries(FILES))
{
	index.setFile(vscode.Uri.file(p).toString(), p, text);
}
index.setManifest(vscode.Uri.file("/ws/mods/chat/info.json").toString(), "/ws/mods/chat/info.json",
	JSON.stringify({ id: "chat-module", name: "Chat", description: "Chat helpers", version: "1.2.0" }));

const service = {
	index,
	analyzer,
	getRecord(document)
	{
		return index.setFile(document.uri.toString(), document.uri.fsPath, document.getText(), false, { calls: true });
	},
};
const providers = createProviders(service);

// Creates /ws/main.pluto from text containing a `|` cursor marker.
function at(text)
{
	const offset = text.indexOf("|");
	assert(offset != -1, "missing cursor marker");
	const clean = text.slice(0, offset) + text.slice(offset + 1);
	const before = clean.slice(0, offset).split("\n");
	const document = vscode.createDocument("/ws/main.pluto", clean);
	return { document, position: new vscode.Position(before.length - 1, before[before.length - 1].length) };
}

function complete(text, context)
{
	const { document, position } = at(text);
	const items = providers.completionProvider.provideCompletionItems(document, position, null, context || { triggerKind: 0 }) || [];
	return { items, labels: items.map(i => i.label), get: (label) => items.find(i => i.label == label) };
}

function hover(text)
{
	const { document, position } = at(text);
	const h = providers.hoverProvider.provideHover(document, position);
	return h ? h.contents.map(c => c.value).join("\n---\n") : null;
}

function signature(text)
{
	const { document, position } = at(text);
	return providers.signatureProvider.provideSignatureHelp(document, position);
}

function definition(text)
{
	const { document, position } = at(text);
	return providers.definitionProvider.provideDefinition(document, position);
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

test("parser: classes, methods and fields", function ()
{
	const { symbols } = parse(FILES["/ws/lib/human.pluto"]);
	const sig = (name) => formatSignature(symbols.find(s => s.name == name && s.kind != "parameter"));
	assert.strictEqual(sig("Human"), "class Human extends Animal");
	assert.strictEqual(sig("__construct"), "function Human:__construct(name: string, age: number = 3)");
	assert.strictEqual(sig("getName"), "function Human:getName(): string");
	assert.strictEqual(sig("create"), "static function Human.create(name: string, age?: number): Human");
	assert.strictEqual(sig("name"), "public Human.name: string");
	assert.strictEqual(sig("count"), "static Human.count = 0");
	assert.strictEqual(sig("greet"), "function greet(who: string, loud?: bool): string");
	assert.strictEqual(sig("GREEN"), "Color.GREEN = 5");
	assert.strictEqual(symbols.find(s => s.name == "Human").doc, "A human being.\nWalks upright.");
	assert.strictEqual(symbols.find(s => s.name == "__construct").doc, "Creates a human.");
	assert(symbols.some(s => s.name == "age" && s.kind == "field" && s.container == "Human"), "self.age is a field");
	assert.strictEqual(symbols.find(s => s.name == "Human").endLine, 20);
});

test("parser: Lua-style modules, lambdas and table members", function ()
{
	const { symbols, returnName } = parse([
		"local M = {",
		"    key = 1,",
		"    fn = function(a) end,",
		"    function meth(b) end,",
		"    static function st(c) end,",
		"}",
		"M.helper = function(q) end",
		"local lam = |a, b| -> a + b",
		"local f <const> = function(x) end",
		"globalFn = function(z) end",
		"$declare function tonumber(str: string, base: ?number): number",
		"return M",
	].join("\n"));
	const sig = (name) => formatSignature(symbols.find(s => s.name == name && s.kind != "parameter"));
	assert.strictEqual(sig("key"), "M.key = 1");
	assert.strictEqual(sig("fn"), "function M.fn(a)");
	assert.strictEqual(sig("meth"), "function M:meth(b)");
	assert.strictEqual(sig("st"), "static function M.st(c)");
	assert.strictEqual(sig("helper"), "function M.helper(q)");
	assert.strictEqual(sig("lam"), "local function lam(a, b)");
	assert.strictEqual(sig("f"), "local function f(x)");
	assert.strictEqual(sig("globalFn"), "function globalFn(z)");
	assert.strictEqual(sig("tonumber"), "function tonumber(str: string, base: ?number): number");
	assert.strictEqual(returnName, "M");
});

test("parser: block structure survives Pluto-specific syntax", function ()
{
	const source = [
		"local x = if a then 1 else 2",          // ternary: no `end`
		"local t = { class = 1, end = 2, enum = 3 }",
		"$if DEBUG then",
		"$end",
		"if a do b() end",                       // `do` instead of `then`
		"switch x do",
		"    case 1: if a then b() end",
		"    default:",
		"end",
		"repeat local r = 1 until r",
		"for t as v do end",
		"local s = [[ end if function ]]",
		"-- end end end",
		"--[==[ function ]==]",
		"::continue::",
		"goto continue",
		"local g = |x| -> do return x end",
		"local class = 1",
		"local str = \"if then\"",
		"enum class E begin A, B end",
		"function outer()",
		"    local function inner() end",
		"end",
	].join("\n");
	const parsed = parse(source);
	assert.strictEqual(parsed.unclosed, 0);
	const outer = parsed.symbols.find(s => s.name == "outer");
	assert.strictEqual(outer.endLine, outer.line + 2);
	const inner = parsed.symbols.find(s => s.name == "inner");
	assert.deepStrictEqual([inner.scopeStart, inner.scopeEnd], [outer.line + 1, outer.line + 2]);
});

test("parser: unclosed blocks are counted, malformed input never throws", function ()
{
	assert.strictEqual(parse("function f()\n  if x then\n").unclosed, 2);
	assert.strictEqual(parse("class A\n  function m()\n  end\n").unclosed, 1);
	for (const garbage of ["", "end end end", "}}}", "function", "class", "local", "function (", "local x = {{{", "\"unterminated", "--[[ open", "enum", "for", "new", "$", "a.b.", "|||"])
	{
		parse(garbage);
	}
});

test("parser: folding ranges", function ()
{
	const text = "if a then\n x()\nelseif b then\n y()\nelse\n z()\nend\n-- a\n-- b\n--#region R\nlocal q\n--#endregion\n--[[\n c\n]]";
	const ranges = computeFolding(text, parse(text));
	const has = (start, end, kind) => ranges.some(r => r.start == start && r.end == end && r.kind == kind);
	assert(has(0, 1), "if branch");
	assert(has(2, 3), "elseif branch");
	assert(has(4, 5), "else branch");
	assert(has(7, 8, "comment"), "line comments");
	assert(has(9, 11, "region"), "region");
	assert(has(12, 14, "comment"), "block comment");
});

// ---------------------------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------------------------

test("builtins: Pluto standard library is known", function ()
{
	for (const name of ["string.startswith", "string.endswith", "string.split", "table.contains", "io.listdir",
		"json.encode", "json.decode", "base64.encode", "crypto.sha256", "http.request", "url.parse", "regex.new",
		"print", "pairs", "string.format", "table.insert", "dumpvar"])
	{
		assert(builtins.functions.has(name), name);
	}
	for (const id of ["pluto:json", "pluto:regex", "pluto:crypto", "pluto:base64", "pluto:http", "pluto:url"])
	{
		assert(builtins.modules.some(m => m.id == id), id);
	}
	assert.strictEqual(builtins.formatBuiltinSignature(builtins.functions.get("string.split")), "function string.split(str, separator, limit?)");
	for (const kw of ["class", "extends", "new", "switch", "case", "default", "enum", "local", "function", "try", "catch", "pluto_use"])
	{
		assert(builtins.keywordMap.has(kw), kw);
	}
});

// ---------------------------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------------------------

test("analysis: expression chains", function ()
{
	assert.deepStrictEqual(chainBefore("  foo.bar:ba", 12), { receiver: ["foo", "bar"], seps: [".", ":"], prefix: "ba" });
	assert.deepStrictEqual(chainBefore("x = a?.b.", 9).receiver, ["a", "b"]);
	const c = chainAt("local v = foo.bar:baz()", 15);
	assert.deepStrictEqual(c.parts, ["foo", "bar"]);
	assert.strictEqual(chainAt("x = 123", 5), null);
});

test("analysis: findCall", function ()
{
	assert.deepStrictEqual(findCall("foo(a, b, "), { parts: ["foo"], seps: [], isNew: false, activeParam: 2 });
	assert.strictEqual(findCall("foo(a, {x, y, z}, bar(1, 2), ").activeParam, 3);
	assert.deepStrictEqual(findCall("local h = new Human(\"a, b\", ").parts, ["Human"]);
	assert.strictEqual(findCall("local h = new Human(\"a, b\", ").isNew, true);
	assert.strictEqual(findCall("local h = new Human(\"a, b\", ").activeParam, 1);
	assert.deepStrictEqual(findCall("a.b:c(1, f(2").parts, ["f"]);
	assert.strictEqual(findCall("function foo(a, "), null);
	assert.strictEqual(findCall("foo(1) + "), null);
	assert.strictEqual(findCall("x = (1 + "), null);
	assert.strictEqual(findCall("foo(1, 2) -- note (a, "), null);
});

// ---------------------------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------------------------

test("completion: keywords, built-ins, workspace symbols and locals", function ()
{
	const c = complete("local myLocal = 1\nlocal function helper(a) end\n|");
	for (const label of ["class", "extends", "switch", "pluto_use", "print", "dumpvar", "string", "json", "Human", "Animal", "greet", "Color", "RED", "myLocal", "helper"])
	{
		assert(c.labels.includes(label), "missing " + label);
	}
	assert(!c.labels.includes("hidden"), "locals of other files must not leak");
	assert.strictEqual(c.get("greet").detail, "function greet(who: string, loud?: bool): string");
	assert(c.get("greet").documentation.value.includes("Greets someone."));
	assert(c.get("greet").documentation.value.includes("[human.pluto:29]"));
	assert.strictEqual(c.get("try").tags[0], vscode.CompletionItemTag.Deprecated);
});

test("completion: locals respect scope", function ()
{
	const c = complete("function a(paramA)\n  local inner = 1\nend\nfunction b(paramB)\n  |\nend");
	assert(c.get("paramB") && c.get("paramB").kind == vscode.CompletionItemKind.Variable);
	// `inner` and `paramA` are out of scope; they may only show up as plain document words.
	assert.strictEqual(c.get("inner").kind, vscode.CompletionItemKind.Text);
	assert.strictEqual(c.get("paramA").kind, vscode.CompletionItemKind.Text);
});

test("completion: class members", function ()
{
	let c = complete("local h = new Human(\"x\")\nh:|");
	assert.deepStrictEqual(c.labels.sort(), ["__construct", "getName", "speak"]);
	c = complete("local h = new Human(\"x\")\nh.|");
	for (const label of ["name", "age", "legs", "getName", "speak"])
	{
		assert(c.labels.includes(label), "missing " + label);
	}
	c = complete("Human.|");
	assert(c.labels.includes("create") && c.labels.includes("count"));
	assert.strictEqual(c.get("create").detail, "static function Human.create(name: string, age?: number): Human");
	c = complete("class Kid extends Human\n  function play()\n    self:|\n  end\nend");
	assert(c.labels.includes("play") && c.labels.includes("getName") && c.labels.includes("speak"));
	c = complete("class Kid extends Human\n  function play()\n    parent:|\n  end\nend");
	assert(c.labels.includes("getName") && !c.labels.includes("play"));
	c = complete("function f(h: Human)\n  h:get|\nend");
	assert(c.labels.includes("getName"));
	c = complete("Color.|");
	assert.deepStrictEqual(c.labels.sort(), ["GREEN", "RED"]);
});

test("completion: built-in libraries and required modules", function ()
{
	let c = complete("string.|");
	for (const label of ["startswith", "endswith", "split", "format"])
	{
		assert(c.labels.includes(label), "missing " + label);
	}
	assert.strictEqual(c.get("split").detail, "function string.split(str, separator, limit?)");
	c = complete("local j = require \"pluto:json\"\nj.|");
	assert.deepStrictEqual(c.labels.sort(), ["decode", "encode"]);
	c = complete("local j = require(\"json\")\nj.|");
	assert.deepStrictEqual(c.labels.sort(), ["decode", "encode"]);
	c = complete("local util = require(\"lib.util\")\nutil.|");
	assert.deepStrictEqual(c.labels.sort(), ["add", "method", "version"]);
	c = complete("local chat = require(\"chat-module\")\nchat.|");
	assert.deepStrictEqual(c.labels, ["send"]);
	c = complete("local s = \"abc\"\ns:|");
	assert(c.labels.includes("split") && c.labels.includes("upper"));
	c = complete("(\"abc\"):|");
	assert(c.labels.includes("split"), "unknown receivers get string methods");
	c = complete("local t = {}\ntable.|");
	assert(c.labels.includes("contains") && c.labels.includes("insert"));
});

test("completion: module names inside require", function ()
{
	const c = complete("local x = require(\"|\")", { triggerKind: 1, triggerCharacter: "\"" });
	for (const label of ["pluto:json", "pluto:regex", "pluto:crypto", "pluto:base64", "pluto:http", "pluto:url", "chat-module", "lib.util", "lib.human"])
	{
		assert(c.labels.includes(label), "missing " + label);
	}
	assert(c.get("chat-module").detail.includes("mods/chat/info.json"));
	// A manifest id is offered in other strings only on explicit request.
	assert.deepStrictEqual(complete("print(\"|\")", { triggerKind: 1, triggerCharacter: "\"" }).labels, []);
	assert.deepStrictEqual(complete("print(\"|\")", { triggerKind: 0 }).labels, ["chat-module"]);
});

test("completion: stays quiet in comments, declarations and after concatenation", function ()
{
	assert.deepStrictEqual(complete("-- some comment |").labels, []);
	assert.deepStrictEqual(complete("local function na|").labels, []);
	assert.deepStrictEqual(complete("class Na|").labels, []);
	assert(complete("local x = a..|").labels.includes("print"), "`..` is not a member access");
	const c = complete("local h = new |");
	assert(c.labels.includes("Human") && !c.labels.includes("print"));
});

// ---------------------------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------------------------

test("hover: workspace declarations show signature, docs and source", function ()
{
	let h = hover("gre|et(\"x\")");
	assert(h.includes("function greet(who: string, loud?: bool): string"));
	assert(h.includes("Greets someone."));
	assert(h.includes("human.pluto:29"));
	h = hover("local h = new Hu|man(\"x\")");
	assert(h.includes("class Human extends Animal") && h.includes("A human being.") && h.includes("Walks upright."));
	assert(h.includes("function Human:__construct(name: string, age: number = 3)"));
	h = hover("local h = new Human(\"x\")\nh:getN|ame()");
	assert(h.includes("function Human:getName(): string") && h.includes("Returns the name."));
	h = hover("local h = new Human(\"x\")\nh:spe|ak()");
	assert(h.includes("function Animal:speak(sound: string)"), "inherited method");
	h = hover("local util = require(\"lib.util\")\nutil.ad|d(1, 2)");
	assert(h.includes("function M.add(a, b)") && h.includes("Adds two numbers.") && h.includes("util.lua:3"));
	h = hover("function f(count: number)\n  return cou|nt\nend");
	assert(h.includes("(parameter) count: number"));
});

test("hover: source link format", function ()
{
	// Other file, default "short": file name + line, full path as tooltip.
	let h = hover("gre|et(\"x\")");
	assert(h.includes("[human.pluto:29](file:///ws/lib/human.pluto#L29 \"lib/human.pluto\")"), h);
	assert(!h.includes("Defined in"));
	// Same file: just the line.
	h = hover("--- Local doc\nlocal function helper() end\nhel|per()");
	assert(h.includes("[Line 2](file:///ws/main.pluto#L2)"), h);
	vscode.config["hover.sourcePath"] = "relative";
	h = hover("gre|et(\"x\")");
	assert(h.includes("[lib/human.pluto:29]("), h);
	vscode.config["hover.sourcePath"] = "none";
	h = hover("gre|et(\"x\")");
	assert(!h.includes("human.pluto"), h);
	delete vscode.config["hover.sourcePath"];
});

test("hover: built-ins, modules and keywords", function ()
{
	let h = hover("string.spl|it(s, \",\")");
	assert(h.includes("function string.split(str, separator, limit?)") && h.includes("Splits a string by a separator."));
	h = hover("local s = \"\"\ns:starts|with(\"a\")");
	assert(h.includes("function string.startswith(str, prefix)"));
	h = hover("local json = require \"pluto:json\"\njson.enc|ode({})");
	assert(h.includes("function json.encode(data, format?)") && h.includes("pluto:json"));
	h = hover("local json = require \"pluto:js|on\"");
	assert(h.includes("(built-in module) pluto:json") && h.includes("`encode`"));
	h = hover("local c = require(\"chat-mod|ule\")");
	assert(h.includes("(module) chat-module 1.2.0") && h.includes("Chat helpers") && h.includes("mods/chat/info.json"));
	h = hover("swi|tch x do end");
	assert(h.includes("(keyword) switch"));
	assert.strictEqual(hover("-- gre|et"), null);
	assert.strictEqual(hover("local x = unknown|Thing"), null);
});

// ---------------------------------------------------------------------------------------------
// Signature help
// ---------------------------------------------------------------------------------------------

test("signature help: active parameter follows commas", function ()
{
	let s = signature("greet(|");
	assert.strictEqual(s.signatures[0].label, "greet(who: string, loud?: bool): string");
	assert.strictEqual(s.activeParameter, 0);
	assert.deepStrictEqual(s.signatures[0].parameters.map(p => s.signatures[0].label.slice(p.label[0], p.label[1])), ["who: string", "loud?: bool"]);
	s = signature("greet(\"a, b\", |");
	assert.strictEqual(s.activeParameter, 1);
	s = signature("greet(f(1, 2), {1, 2}, |");
	assert.strictEqual(s.activeParameter, 2, "past the last parameter");
	s = signature("local h = new Human(\"x\", |");
	assert.strictEqual(s.signatures[0].label, "new Human(name: string, age: number = 3)");
	assert.strictEqual(s.activeParameter, 1);
	s = signature("Human.create(|");
	assert.strictEqual(s.signatures[0].label, "Human.create(name: string, age?: number): Human");
	s = signature("string.split(s, |");
	assert.strictEqual(s.signatures[0].label, "string.split(str, separator, limit?)");
	assert.strictEqual(s.activeParameter, 1);
	s = signature("local s = \"\"\ns:split(|");
	assert.strictEqual(s.activeParameter, 1, "the receiver takes the first parameter");
	s = signature("print(1, 2, 3, |");
	assert.strictEqual(s.activeParameter, 0, "varargs stay highlighted");
	assert.strictEqual(signature("function foo(a, |"), undefined);
	assert.strictEqual(signature("unknownFn(|"), undefined);
});

// ---------------------------------------------------------------------------------------------
// Definition, outline, folding
// ---------------------------------------------------------------------------------------------

test("definition: classes, methods, functions, locals and require", function ()
{
	let d = definition("local h = new Hu|man(\"x\")");
	assert.strictEqual(d[0].uri.path, "/ws/lib/human.pluto");
	assert.strictEqual(d[0].range.start.line, 2);
	d = definition("local h = new Human(\"x\")\nh:getN|ame()");
	assert.deepStrictEqual([d[0].uri.path, d[0].range.start.line], ["/ws/lib/human.pluto", 13]);
	d = definition("gre|et()");
	assert.deepStrictEqual([d[0].uri.path, d[0].range.start.line], ["/ws/lib/human.pluto", 28]);
	d = definition("local value = 1\nprint(val|ue)");
	assert.deepStrictEqual([d[0].uri.path, d[0].range.start.line], ["/ws/main.pluto", 0]);
	d = definition("local util = require(\"lib.ut|il\")");
	assert.strictEqual(d[0].targetUri.path, "/ws/lib/util.lua");
	d = definition("local chat = require \"chat-mod|ule\"");
	assert.strictEqual(d[0].targetUri.path, "/ws/mods/chat/init.pluto");
	assert.strictEqual(definition("local j = require \"pluto:js|on\""), undefined);
	d = definition("local util = require(\"lib.util\")\nutil.ad|d(1, 2)");
	assert.deepStrictEqual([d[0].uri.path, d[0].range.start.line], ["/ws/lib/util.lua", 2]);
});

test("outline: hierarchy of classes, methods and functions", function ()
{
	const document = vscode.createDocument("/ws/lib/human.pluto", FILES["/ws/lib/human.pluto"]);
	const roots = providers.documentSymbolProvider.provideDocumentSymbols(document);
	assert.deepStrictEqual(roots.map(r => r.name), ["Human", "Color", "greet"]);
	const human = roots[0];
	assert.strictEqual(human.kind, vscode.SymbolKind.Class);
	assert.strictEqual(human.detail, "extends Animal");
	assert.deepStrictEqual(human.children.map(c => c.name), ["name", "count", "__construct", "age", "getName", "create"]);
	assert.strictEqual(human.children.find(c => c.name == "create").detail, "static (name: string, age?: number): Human");
	assert.deepStrictEqual(roots[1].children.map(c => c.name), ["RED", "GREEN"]);
	for (const node of [...roots, ...human.children])
	{
		assert(node.range.contains(node.selectionRange), node.name + ": selectionRange must be inside range");
	}

	const lua = providers.documentSymbolProvider.provideDocumentSymbols(vscode.createDocument("/ws/lib/util.lua", FILES["/ws/lib/util.lua"]));
	assert.deepStrictEqual(lua.map(r => r.name), ["M", "hidden"]);
	assert.deepStrictEqual(lua[0].children.map(c => c.name), ["add", "method", "version"]);

	const nested = providers.documentSymbolProvider.provideDocumentSymbols(vscode.createDocument("/ws/n.pluto",
		"function outer()\n  local function inner()\n    return 1\n  end\n  return inner\nend\nfunction Unknown:method()\nend"));
	assert.deepStrictEqual(nested.map(r => r.name), ["outer", "Unknown:method"]);
	assert.deepStrictEqual(nested[0].children.map(c => c.name), ["inner"]);
});

test("outline: locals, callbacks, constants and settings", function ()
{
	const source = [
		"local json = require \"pluto:json\"",
		"local SAVE_FOLDER = \"saves/\"",
		"--- @deprecated",
		"local function load(handle: int): ?table",
		"    local data = { handle = handle }",
		"    for i = 1, 3 do",
		"        local tmp = i",
		"    end",
		"    scheduler:add(function()",
		"        local inner = 1",
		"    end)",
		"    list:foreach(|item| -> do",
		"        print(item)",
		"    end)",
		"    return data",
		"end",
	].join("\n");
	const document = vscode.createDocument("/ws/outline.pluto", source);
	const K = vscode.SymbolKind;
	const flat = (nodes, depth = 0) => nodes.flatMap(n => [[depth, n.name, n.kind, n.detail], ...flat(n.children, depth + 1)]);

	let tree = flat(providers.documentSymbolProvider.provideDocumentSymbols(document));
	assert.deepStrictEqual(tree, [
		[0, "json", K.Module, "require \"pluto:json\""],
		[0, "SAVE_FOLDER", K.Constant, "string = \"saves/\""],
		[0, "load", K.Function, "(handle: int): ?table"],
		[1, "data", K.Object, "= { handle = handle }"],
		[2, "handle", K.Field, "= handle"],
		[1, "tmp", K.Variable, "= i"],
		[1, "scheduler:add() callback", K.Function, "()"],
		[2, "inner", K.Variable, "= 1"],
		[1, "list:foreach() callback", K.Function, "(item)"],
	]);
	const load = providers.documentSymbolProvider.provideDocumentSymbols(document)[2];
	assert.deepStrictEqual(load.tags, [vscode.SymbolTag.Deprecated]);

	Object.assign(vscode.config, {
		"outline.localVariables": false,
		"outline.loopVariables": true,
		"outline.parameters": true,
		"outline.anonymousFunctions": false,
		"outline.showValues": false,
	});
	try
	{
		tree = flat(providers.documentSymbolProvider.provideDocumentSymbols(document)).map(e => e.slice(0, 2).concat(e[3]));
		assert.deepStrictEqual(tree, [
			[0, "json", "require \"pluto:json\""],
			[0, "SAVE_FOLDER", "string"],
			[0, "load", "(handle: int): ?table"],
			[1, "handle", "int"],
			[1, "i", ""],
		]);
	}
	finally
	{
		for (const key of Object.keys(vscode.config))
		{
			delete vscode.config[key];
		}
	}
});

test("outline: function bodies, calls and the large-file guard", function ()
{
	const source = [
		"local module = {}",
		"function module.get_coords(entity: int)",
		"    local coords = v3.new(ENTITY.GET_ENTITY_COORDS(entity))",
		"    util.toast(\"x\")",
		"    util.toast(\"y\")",
		"    scheduler:add(function()",
		"        log(\"inner\")",
		"    end)",
		"    if not coords then return nil end",
		"    return coords",
		"end",
		"function module.get_health(entity: int): int",
		"    return ENTITY.GET_ENTITY_HEALTH(entity)",
		"end",
	].join("\n");
	const document = vscode.createDocument("/ws/body.pluto", source);
	const K = vscode.SymbolKind;
	const flat = (nodes, depth = 0) => nodes.flatMap(n => [[depth, n.name, n.detail], ...flat(n.children, depth + 1)]);
	const outline = () => flat(providers.documentSymbolProvider.provideDocumentSymbols(document));
	const reset = () => Object.keys(vscode.config).forEach(k => delete vscode.config[k]);
	try
	{
		// Default: locals and callbacks, no calls.
		assert.deepStrictEqual(outline(), [
			[0, "module", "= {}"],
			[1, "get_coords", "(entity: int)"],
			[2, "coords", "= v3.new(ENTITY.GET_ENTITY_COORDS(entity))"],
			[2, "scheduler:add() callback", "()"],
			[1, "get_health", "(entity: int): int"],
		]);

		// Statement calls and returns; the call with a callback is represented by the callback.
		vscode.config["outline.calls"] = "statements";
		assert.deepStrictEqual(outline(), [
			[0, "module", "= {}"],
			[1, "get_coords", "(entity: int)"],
			[2, "coords", "= v3.new(ENTITY.GET_ENTITY_COORDS(entity))"],
			[2, "util.toast()", "(\"x\")"],
			[2, "util.toast()", "(\"y\")"],
			[2, "scheduler:add() callback", "()"],
			[3, "log()", "(\"inner\")"],
			[2, "return", "nil"],
			[2, "return", "coords"],
			[1, "get_health", "(entity: int): int"],
			[2, "return", "ENTITY.GET_ENTITY_HEALTH(entity)"],
		]);
		const fn =providers.documentSymbolProvider.provideDocumentSymbols(document)[0].children[0];
		assert.strictEqual(fn.children.find(c => c.name == "util.toast()").kind, K.Event);
		assert.strictEqual(fn.children.find(c => c.name == "return").kind, K.Operator);

		// All calls, each callee once per function.
		vscode.config["outline.calls"] = "all";
		const all = outline().filter(e => e[1].endsWith("()")).map(e => e[0] + " " + e[1]);
		assert.deepStrictEqual(all, ["2 v3.new()", "2 ENTITY.GET_ENTITY_COORDS()", "2 util.toast()", "3 log()", "2 ENTITY.GET_ENTITY_HEALTH()"]);

		// Large-file guard: only signatures.
		const signaturesOnly = [
			[0, "module", "= {}"],
			[1, "get_coords", "(entity: int)"],
			[1, "get_health", "(entity: int): int"],
		];
		vscode.config["outline.maxFileLines"] = 10;
		assert.deepStrictEqual(outline(), signaturesOnly);
		vscode.config["outline.maxFileLines"] = 0; // no limit
		assert(outline().length > 3);
		vscode.config["outline.maxFileLines"] = 1000;
		vscode.config["outline.showFunctionBody"] = false;
		assert.deepStrictEqual(outline(), signaturesOnly);
	}
	finally
	{
		reset();
	}
});

test("parser: calls are only collected on request", function ()
{
	const src = "function f()\n  foo(1)\nend\nbar()\n";
	assert.strictEqual(parse(src).calls, undefined);
	const calls = parse(src, { calls: true }).calls;
	assert.deepStrictEqual(calls.map(c => c.name), ["foo()"], "calls outside of functions are skipped");
});

test("folding provider", function ()
{
	const document = vscode.createDocument("/ws/lib/human.pluto", FILES["/ws/lib/human.pluto"]);
	const ranges = providers.foldingProvider.provideFoldingRanges(document);
	assert(ranges.some(r => r.start == 2 && r.end == 19), "class");
	assert(ranges.some(r => r.start == 7 && r.end == 9), "constructor");
	assert(ranges.some(r => r.start == 0 && r.end == 1 && r.kind == vscode.FoldingRangeKind.Comment), "comment");
});

// ---------------------------------------------------------------------------------------------
// Auto-closing of blocks, language configuration, manifest
// ---------------------------------------------------------------------------------------------

test("auto-close: which lines get an `end`", function ()
{
	const expectEnd = ["function foo()", "local function foo(a, b)", "function Foo:bar(a: number): string", "if x then", "if x do",
		"for i = 1, 10 do", "for k, v in pairs(t) do", "while true do", "class Foo", "class Foo extends Bar", "local class Foo",
		"export class Foo", "switch x do", "try", "do", "enum Color begin", "local f = function(a)", "foo(function()", "\tstatic function create()",
		"M.x = function()  -- comment", "scheduler:add(|| -> do", "return function()"];
	for (const line of expectEnd)
	{
		assert.strictEqual(closerFor(line), "end", line);
	}
	assert.strictEqual(closerFor("repeat"), "until ");
	// In a Lua file the words and forms only Pluto has get no `end`; the common ones do.
	for (const line of ["function foo()", "if x then", "for i = 1, 10 do", "while true do", "do", "local f = function(a)", "foo(function()"])
	{
		assert.strictEqual(closerFor(line, true), "end", "lua: " + line);
	}
	for (const line of ["class Foo", "switch x do", "try", "enum Color begin", "export class Foo", "static function create()", "scheduler:add(|| -> do", "if x do", "local c = class"])
	{
		assert.strictEqual(closerFor(line, true), null, "lua: " + line);
	}
	const expectNothing = ["", "local x = 1", "if x then return end", "else", "elseif y then", "case 1:", "default:", "catch e then",
		"-- if x then", "print(\"if x then\")", "function foo() end", "$if DEBUG then", "local t = {", "x = y", "$declare function f(a: string): number"];
	for (const line of expectNothing)
	{
		assert.strictEqual(closerFor(line), null, line);
	}
});

test("inline suggestions: the half typed word is finished, not repeated", function ()
{
	const { inlineSuggestionsAt, partialWordAt, finishWord } = require("../src/autoFormat");
	const options = { parens: true, keyAssign: true, blockWords: true, forHints: false, ifWord: "then" };
	// what the provider shows for the text before the cursor `|`
	const shown = function (marked)
	{
		const offset = marked.indexOf("|");
		const text = marked.replace("|", "");
		const partial = partialWordAt(text, offset);
		const finishing = [];
		for (const word of partial ? ["then", "do"] : [])
		{
			// after an `if` both words are right, whichever is preferred
			for (const s of finishWord(inlineSuggestionsAt(partial.text, partial.offset, Object.assign({}, options, { ifWord: word })), partial.word))
			{
				if (!finishing.some((f) => f.insert == s.insert))
				{
					finishing.push(s);
				}
			}
		}
		return (finishing.length ? finishing : inlineSuggestionsAt(text, offset, options)).map(s => s.insert);
	};
	assert.deepStrictEqual(shown("if test_object th|"), ["en"]);
	assert.deepStrictEqual(shown("if test_object t|"), ["hen"]);
	assert.deepStrictEqual(shown("if test_object the|"), ["n"]);
	assert.deepStrictEqual(shown("if test_object then|"), []);
	assert.deepStrictEqual(shown("if test_object |"), ["then"]);
	assert.deepStrictEqual(shown("if test_object|"), [" then"]);
	assert.deepStrictEqual(shown("while running d|"), ["o"]);
	assert.deepStrictEqual(shown("if test_object d|"), ["o"]);
	assert.deepStrictEqual(shown("elseif test_object do|"), []);
	assert.deepStrictEqual(shown("for k, v in pairs(t) do|"), []);
	// a name of its own stays a name: the word is a part of the condition
	assert.deepStrictEqual(shown("if t|"), [" then"]);
	assert.deepStrictEqual(shown("if a and th|"), [" then"]);
	assert.deepStrictEqual(shown("if a == t|"), [" then"]);
	assert.deepStrictEqual(shown("if a == |"), []);
	// a word that does not go on with any suggestion: as before, the condition is taken as it stands
	assert.deepStrictEqual(shown("if test_object xyz|"), [" then"]);
	// the words themselves
	assert.deepStrictEqual(finishWord([{ insert: "then" }, { insert: " do" }, { insert: "()", snippet: "($0)" }], "th").map(s => s.insert), ["en"]);
	assert.deepStrictEqual(finishWord([{ insert: "return", snippet: "return $1" }], "ret"), [{ insert: "urn", snippet: "urn $1" }]);
	assert.strictEqual(partialWordAt("foo(th", 6), null);
	assert.strictEqual(partialWordAt("if x th end", 7), null);
});

test("quick delete: two presses in a row on a lone `end` remove the line", function ()
{
	const { quickDeleteDecision } = require("../src/extension");
	const WINDOW = 1500;
	const here = (line, now) => ({ uri: "file:///a.pluto", line, now });
	const first = (text, now) => quickDeleteDecision(text, null, here(5, now), WINDOW);
	const armed = { uri: "file:///a.pluto", line: 5, at: 1000 };
	// the first press: the plain key, remembered when the line is a lone `end`
	assert.strictEqual(first("\tend", 1000).action, "arm");
	assert.deepStrictEqual(first("\tend", 1000).pending, armed);
	assert.strictEqual(first("end", 1000).action, "arm");
	assert.strictEqual(first("\tend   ", 1000).action, "arm");
	// any other line, or a part of the word without a press before it: nothing to remember
	for (const text of ["\ten", "\tend x", "x = 1 end", "", "\tfoo()"])
	{
		const step = first(text, 1000);
		assert.strictEqual(step.action, "plain", text);
		assert.strictEqual(step.pending, null, text);
	}
	// the second press, right after: what is left of the line goes (a letter, two, or the indentation was deleted)
	for (const text of ["\ten", "\te", "end", "\t", "\tend", "\tnd", "\td"])
	{
		const step = quickDeleteDecision(text, armed, here(5, 2500), WINDOW);
		assert.strictEqual(step.action, "remove", JSON.stringify(text));
		assert.strictEqual(step.pending, null);
	}
	// text that is not the rest of `end` is never removed
	assert.strictEqual(quickDeleteDecision("\tnx", armed, here(5, 1100), WINDOW).action, "plain");
	assert.strictEqual(quickDeleteDecision("\tfoo()", armed, here(5, 1100), WINDOW).action, "plain");
	// too late, another line or another file: a new first press
	assert.strictEqual(quickDeleteDecision("\ten", armed, here(5, 2501), WINDOW).action, "plain");
	assert.strictEqual(quickDeleteDecision("\tend", armed, here(5, 2501), WINDOW).action, "arm");
	assert.strictEqual(quickDeleteDecision("\tend", armed, here(6, 1100), WINDOW).action, "arm");
	assert.strictEqual(quickDeleteDecision("\tend", armed, { uri: "file:///b.pluto", line: 5, now: 1100 }, WINDOW).action, "arm");
	// the time is a parameter
	assert.strictEqual(quickDeleteDecision("\ten", armed, here(5, 1200), 200).action, "remove");
	assert.strictEqual(quickDeleteDecision("\ten", armed, here(5, 1201), 200).action, "plain");
});

test("heirs: the classes that extend a class, down the chain of `extends`", function ()
{
	const { WorkspaceIndex } = require("../src/workspaceIndex");
	const { selectedName, outOfSight } = require("../src/heirsPeek");
	const idx = new WorkspaceIndex();
	idx.setFile("file:///a.pluto", "/a.pluto", ["class Entity", "end", "", "class Human extends Entity", "end", "class Cat extends Entity", "end"].join("\n"));
	idx.setFile("file:///b.pluto", "/b.pluto", ["class Hero extends Human", "end", "class Other", "end", "class Boss extends mod.Hero", "end"].join("\n"));
	const names = (name) => idx.subclasses(name).map(h => h.sym.name + ":" + h.depth);
	assert.deepStrictEqual(names("Entity"), ["Human:1", "Cat:1", "Hero:2", "Boss:3"]);
	assert.deepStrictEqual(names("Human"), ["Hero:1", "Boss:2"]);
	assert.deepStrictEqual(names("Boss"), []);
	assert.deepStrictEqual(names("Other"), []);
	assert.deepStrictEqual(names("Nope"), []);
	assert.strictEqual(idx.subclasses("Entity")[2].file.key, "file:///b.pluto", "the file of the heir is known");
	assert.strictEqual(idx.subclasses("Entity")[0].sym.line, 3, "and the line of its declaration");
	// a cycle is visited once
	const loop = new WorkspaceIndex();
	loop.setFile("file:///c.pluto", "/c.pluto", ["class A extends B", "end", "class B extends A", "end"].join("\n"));
	assert.deepStrictEqual(loop.subclasses("A").map(h => h.sym.name), ["B", "A"]);
	// the selection has to be the whole name
	assert.strictEqual(selectedName("class Human extends Entity", 20, 26), "Entity");
	assert.strictEqual(selectedName("class Human extends Entity", 6, 11), "Human");
	assert.strictEqual(selectedName("class Human extends Entity", 20, 24), null, "a part of a name");
	assert.strictEqual(selectedName("class Human extends Entity", 21, 26), null, "a part of a name");
	assert.strictEqual(selectedName("class Human extends Entity", 6, 19), null, "more than a name");
	assert.strictEqual(selectedName("local x = 1", 10, 11), null, "a number");
	assert.strictEqual(selectedName("class Сущность", 6, 14), "Сущность");
	// only what is out of sight is shown
	const heirs = [{ key: "a", line: 3 }, { key: "a", line: 60 }, { key: "b", line: 3 }];
	assert.deepStrictEqual(outOfSight(heirs, "a", [{ start: 0, end: 30 }]), [{ key: "a", line: 60 }, { key: "b", line: 3 }]);
	assert.deepStrictEqual(outOfSight(heirs, "a", [{ start: 0, end: 100 }]), [{ key: "b", line: 3 }]);
	assert.deepStrictEqual(outOfSight(heirs, "a", []), heirs);
});

test("rename class: the declaration and the `extends` of the direct heirs", function ()
{
	const { WorkspaceIndex } = require("../src/workspaceIndex");
	const { renamePlaces, checkNewName } = require("../src/renameClass");
	const idx = new WorkspaceIndex();
	idx.setFile("file:///a.pluto", "/a.pluto", ["class Entity", "end", "", "class Human extends Entity", "end"].join("\n"));
	idx.setFile("file:///b.pluto", "/b.pluto", ["class Hero extends Human", "end", "class Boss extends mod.Entity", "end", "local e = new Entity()"].join("\n"));
	const places = renamePlaces(idx, "Entity");
	// the declaration first, then the `extends` of the direct heirs; not the heirs of the heirs, not `new Entity`
	assert.deepStrictEqual(places, [
		{ key: "file:///a.pluto", line: 0, col: 6, endCol: 12, kind: "declaration" },
		{ key: "file:///a.pluto", line: 3, col: 20, endCol: 26, kind: "extends" },
		{ key: "file:///b.pluto", line: 2, col: 23, endCol: 29, kind: "extends" },
	]);
	// the ranges are exactly the name
	const text = ["class Human extends Entity"].join("\n");
	assert.strictEqual(text.slice(20, 26), "Entity");
	assert.deepStrictEqual(renamePlaces(idx, "Human").map(p => p.kind + ":" + p.line), ["declaration:3", "extends:0"]);
	assert.deepStrictEqual(renamePlaces(idx, "Hero").map(p => p.kind), ["declaration"]);
	assert.deepStrictEqual(renamePlaces(idx, "Nope"), []);
	// two classes with one name: both are declarations
	const twin = new WorkspaceIndex();
	twin.setFile("file:///x.pluto", "/x.pluto", "class Entity\nend\n");
	twin.setFile("file:///y.pluto", "/y.pluto", "class Entity\nend\nclass Cat extends Entity\nend\n");
	assert.deepStrictEqual(renamePlaces(twin, "Entity").map(p => p.kind + ":" + p.key.slice(-7)), ["declaration:x.pluto", "declaration:y.pluto", "extends:y.pluto"]);
	// the new name
	assert.strictEqual(checkNewName("Creature", "Entity"), null);
	assert.strictEqual(checkNewName("Сущность", "Entity"), null);
	assert.strictEqual(checkNewName("", "Entity"), "empty");
	assert.strictEqual(checkNewName("1abc", "Entity"), "invalid");
	assert.strictEqual(checkNewName("a b", "Entity"), "invalid");
	assert.strictEqual(checkNewName("end", "Entity"), "reserved");
	assert.strictEqual(checkNewName("Entity", "Entity"), "same");
});

test("shift delete: on an empty line the pieces come from the nearest line with text below", function ()
{
	const { pieceBelow } = require("../src/extension");
	// the whole thing as a loop of presses: what each press takes, until the line is gone
	const eat = function (lines, cursor, forward, presses = 30)
	{
		const doc = lines.slice();
		const taken = [];
		for (let press = 0; press < presses; ++press)
		{
			const r = pieceBelow((n) => doc[n], doc.length, cursor, forward);
			if (!r)
			{
				break;
			}
			taken.push(doc[r.line].slice(r.from, r.to));
			if (r.wholeLine)
			{
				doc.splice(r.line, 1);
			}
			else
			{
				doc[r.line] = doc[r.line].slice(0, r.from) + doc[r.line].slice(r.to);
			}
		}
		return { taken, doc };
	};
	// `end` is a single piece, and the line goes with it
	const end = eat(["if t then", "\t", "end", "foo()"], 1, false, 1);
	assert.deepStrictEqual(end.taken, ["end"]);
	assert.deepStrictEqual(end.doc, ["if t then", "\t", "foo()"]);
	// the screenshot: the cursor on the empty line above the function header; `string` is the first piece
	const header = eat(["", "function greet(): string", "\treturn 1", "end"], 0, false, 6);
	assert.deepStrictEqual(header.taken, ["string", ": ", ")", "(", "greet", "function "]);
	assert.strictEqual(header.doc[0], "", "the cursor line stays");
	assert.strictEqual(header.doc[1], "\treturn 1", "the line with nothing left is gone, the next one is untouched until its turn");
	// Delete takes from the start
	const forward = eat(["", "function greet(): string"], 0, true);
	assert.deepStrictEqual(forward.taken, ["function", " greet", "(", ")", ":", " string"]);
	assert.deepStrictEqual(forward.doc, [""]);
	// the cursor line holds text, or there is no line with text below: nothing to take
	assert.strictEqual(pieceBelow((n) => ["foo", "bar"][n], 2, 0, false), null);
	assert.strictEqual(pieceBelow((n) => ["", "\t"][n], 2, 0, false), null);
	assert.strictEqual(pieceBelow((n) => ["\t"][n], 1, 0, true), null);
	// one press: the range and whether the line goes
	assert.deepStrictEqual(pieceBelow((n) => ["", "\tend"][n], 2, 0, false), { line: 1, from: 1, to: 4, wholeLine: true });
	assert.deepStrictEqual(pieceBelow((n) => ["", "\tself.name"][n], 2, 0, false), { line: 1, from: 6, to: 10, wholeLine: false });
	assert.deepStrictEqual(pieceBelow((n) => ["\t", "", "  foo()"][n], 3, 0, true), { line: 2, from: 0, to: 5, wholeLine: false });
	// the spaces and tabs at the edge of the line below go with the piece next to them, in the same press
	assert.deepStrictEqual(pieceBelow((n) => ["", "\tend   "][n], 2, 0, false), { line: 1, from: 1, to: 7, wholeLine: true }, "trailing spaces with `end`, and the line is gone");
	assert.deepStrictEqual(pieceBelow((n) => ["", "\tfoo(x)  "][n], 2, 0, false), { line: 1, from: 6, to: 9, wholeLine: false }, "spaces and the `)` before them");
	assert.deepStrictEqual(pieceBelow((n) => ["", "\tfoo(x)"][n], 2, 0, true), { line: 1, from: 0, to: 4, wholeLine: false }, "the indentation and `foo`");
	assert.deepStrictEqual(pieceBelow((n) => ["", "    end"][n], 2, 0, true), { line: 1, from: 0, to: 7, wholeLine: true }, "the indentation and `end`");
	assert.strictEqual(pieceBelow((n) => ["", "   "][n], 2, 0, false), null, "an empty line is no line with text");
});

test("shift delete: a piece of the line per press", function ()
{
	const { pieceRange } = require("../src/extension");
	// `self.name|`: `name`, then `.`, then `self`
	const line = "return \"Hi, \" .. self.name";
	let text = line;
	let col = text.length;
	const taken = [];
	for (let n = 0; n < 3; ++n)
	{
		const r = pieceRange(text, col, false);
		assert.ok(r);
		taken.push(text.slice(r.from, r.to));
		text = text.slice(0, r.from) + text.slice(r.to);
		col = r.from;
	}
	assert.deepStrictEqual(taken, ["name", ".", "self"]);
	assert.strictEqual(text, "return \"Hi, \" .. ");
	// spaces and tabs are a piece of their own, an operator is one piece
	assert.deepStrictEqual(pieceRange("return \"Hi, \" .. ", 17, false), { from: 16, to: 17 });
	assert.deepStrictEqual(pieceRange("return \"Hi, \" .. ", 16, false), { from: 14, to: 16 });
	assert.deepStrictEqual(pieceRange("a  ..  b", 8, false), { from: 7, to: 8 });
	assert.deepStrictEqual(pieceRange("a  ..  b", 7, false), { from: 5, to: 7 });
	assert.deepStrictEqual(pieceRange("a  ..  b", 5, false), { from: 3, to: 5 });
	assert.deepStrictEqual(pieceRange("a  ..  b", 3, false), { from: 1, to: 3 });
	assert.deepStrictEqual(pieceRange("foo    ", 7, false), { from: 3, to: 7 });
	assert.deepStrictEqual(pieceRange("foo    ", 3, false), { from: 0, to: 3 });
	assert.deepStrictEqual(pieceRange("foo \t ", 6, false), { from: 3, to: 6 }, "spaces and tabs are one run");
	// a character outside of the BMP is never cut in halves
	assert.deepStrictEqual(pieceRange("x = \"a\u{1F600}\"", 8, false), { from: 6, to: 8 });
	assert.deepStrictEqual(pieceRange("say \u{1F600}", 6, false), { from: 4, to: 6 });
	assert.deepStrictEqual(pieceRange("\u{1F600}\u{1F600}x", 0, true), { from: 0, to: 4 });
	assert.deepStrictEqual(pieceRange("a\u{1F600}b", 3, false), { from: 1, to: 3 });
	assert.deepStrictEqual(pieceRange("foo(bar)", 8, false), { from: 7, to: 8 });
	assert.deepStrictEqual(pieceRange("foo(bar", 7, false), { from: 4, to: 7 });
	assert.deepStrictEqual(pieceRange("x == y", 4, false), { from: 2, to: 4 });
	assert.deepStrictEqual(pieceRange("local x_1 = 5", 13, false), { from: 12, to: 13 });
	assert.deepStrictEqual(pieceRange("local x_1", 9, false), { from: 6, to: 9 });
	assert.deepStrictEqual(pieceRange("имя.поле", 8, false), { from: 4, to: 8 });
	// only indentation to the left: all of it; at the start of the line the plain key joins the lines
	assert.deepStrictEqual(pieceRange("\t\tfoo", 2, false), { from: 0, to: 2 });
	assert.strictEqual(pieceRange("\tfoo", 0, false), null);
	assert.strictEqual(pieceRange("", 0, false), null);
	// the cursor in the middle of a word takes the part in front of it
	assert.deepStrictEqual(pieceRange("foobar", 3, false), { from: 0, to: 3 });
	// Delete goes the other way
	assert.deepStrictEqual(pieceRange("self.name", 0, true), { from: 0, to: 4 });
	assert.deepStrictEqual(pieceRange("self.name", 4, true), { from: 4, to: 5 });
	assert.deepStrictEqual(pieceRange("self.name", 5, true), { from: 5, to: 9 });
	assert.deepStrictEqual(pieceRange("a  ..  b", 1, true), { from: 1, to: 3 });
	assert.deepStrictEqual(pieceRange("a  ..  b", 3, true), { from: 3, to: 5 });
	assert.deepStrictEqual(pieceRange("\tfoo", 0, true), { from: 0, to: 1 }, "the indentation is a piece of its own");
	assert.deepStrictEqual(pieceRange("foo  ", 3, true), { from: 3, to: 5 });
	assert.strictEqual(pieceRange("foo", 3, true), null, "at the end of the line the plain key joins the lines");
});

test("auto-close: an `end` is added only where the block of that line is unclosed", function ()
{
	const { needsEnd } = require("../src/extension");
	// a class that has its `end` further down, in a file with an unclosed function elsewhere
	const closedClass = parse(["function broken(a)", "", "class Entity", "    function f()", "    end", "end", ""].join("\n"));
	assert.ok(closedClass.unclosed > 0);
	assert.strictEqual(needsEnd(closedClass, 2), false);
	// the same class without its `end`
	const openClass = parse(["function broken(a)", "", "class Entity", "    function f()", "    end", ""].join("\n"));
	assert.strictEqual(needsEnd(openClass, 2), true);
	// a block typed in the middle of a function takes the function's `end`: it still needs its own
	const middle = ["function a()", "    if x then", "    foo()", "end", ""];
	assert.strictEqual(needsEnd(parse(middle.join("\n")), 1, (n) => middle[n]), true);
	// the same block with its own `end` below
	const done = ["function a()", "    if x then", "    foo()", "    end", "end", ""];
	assert.strictEqual(needsEnd(parse(done.join("\n")), 1, (n) => done[n]), false);
	// the class of the screenshot, with the text lines at hand
	const cls = ["function broken(a)", "", "class Entity", "    function f()", "    end", "end", ""];
	assert.strictEqual(needsEnd(parse(cls.join("\n")), 2, (n) => cls[n]), false);
	// nothing unclosed at all
	assert.strictEqual(needsEnd(parse("class A\nend\n"), 0), false);
	// the line just typed: a lone opener at the end of the file
	assert.strictEqual(needsEnd(parse("class A\n    \n"), 0), true);
	// do / switch typed above a stray `end`: the file balances out, the block still has no `end` of its own
	for (const head of ["do", "switch test do", "while x do"])
	{
		const stray = ["print(1)", "    " + head, "        ", "    print(2)", "end", ""];
		const rec = parse(stray.join("\n"));
		assert.strictEqual(rec.unclosed, 0);
		assert.strictEqual(needsEnd(rec, 1, (n) => stray[n]), true);
		const own = ["print(1)", "    " + head, "        ", "    end", ""];
		assert.strictEqual(needsEnd(parse(own.join("\n")), 1, (n) => own[n]), false);
	}
});

test("indentation: Enter after block openers (Pluto and Lua)", function ()
{
	const root = path.join(__dirname, "..");
	const load = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8").replace(/^\s*\/\/.*$/gm, ""));
	// What VS Code does on Enter: the first rule whose beforeText (and afterText) match decides.
	const onEnter = function (config, before, after)
	{
		for (const rule of config.onEnterRules)
		{
			if (new RegExp(rule.beforeText).test(before) && (!rule.afterText || new RegExp(rule.afterText).test(after || "")))
			{
				return rule.action.indent;
			}
		}
		return undefined;
	};
	const pluto = load("language-config.json");
	const lua = load("language-config-lua.json");
	const inc = (config, line) => new RegExp(config.indentationRules.increaseIndentPattern).test(line);
	const dec = (config, line) => new RegExp(config.indentationRules.decreaseIndentPattern).test(line);

	const plutoOpeners = ["if x then", "if x do", "elseif x then", "elseif x do", "else", "for i = 1, 3 do", "for k, v in pairs(t) do", "while x do", "repeat",
		"function f()", "local function f()", "\tfunction method(a: int): bool", "class A", "class A extends B", "switch x do", "case 1:", "default:", "do",
		"try", "catch e", "enum Color begin", "x = function(a)", "add(function()", "cb = function(a): int", "local t = {", "\tif a and b then"];
	for (const line of plutoOpeners)
	{
		assert.strictEqual(onEnter(pluto, line, ""), "indent", "indent after: " + line);
		assert.strictEqual(inc(pluto, line), true, "increaseIndentPattern: " + line);
		if (!line.endsWith("{"))
		{
			assert.strictEqual(onEnter(pluto, line, "end"), "indentOutdent", "indentOutdent before end: " + line);
			assert.strictEqual(onEnter(pluto, line, "  end"), "indentOutdent", line);
		}
	}
	assert.strictEqual(onEnter(pluto, "repeat", "until x"), "indentOutdent");
	assert.strictEqual(onEnter(pluto, "local t = {", "}"), "indentOutdent");
	assert.strictEqual(onEnter(pluto, "f(function()", "end)"), "indentOutdent");
	// Doc comments keep their own rule; everything else is left alone.
	assert.strictEqual(onEnter(pluto, "--- Does a thing", ""), "none");
	for (const line of ["local x = 1", "print(1)", "if x then return end", "function f() end", "repeat tick() until x", "-- what to do", "-- if you want", "$type Func = function(_: string): void", "default = 5", "default: int", "local f = function(a) return a end"])
	{
		assert.strictEqual(onEnter(pluto, line, ""), line.startsWith("---") ? "none" : undefined, "no indent after: " + line);
		assert.strictEqual(inc(pluto, line), false, "no increase: " + line);
	}
	// `case`/`default` labels stand at the level of the previous label.
	assert.strictEqual(dec(pluto, "\tcase 2:") && dec(pluto, "default:") && dec(pluto, "else") && dec(pluto, "end"), true);
	assert.strictEqual(dec(pluto, "default = 5") || dec(pluto, "x = case_count"), false);

	const luaOpeners = ["if x then", "elseif x then", "else", "for i = 1, 3 do", "for k, v in pairs(t) do", "while x do", "repeat", "function f()", "function M.add(a, b)",
		"function obj:method()", "local function f()", "do", "cb = function(a)", "add(function()", "local t = {", "M.run = function()"];
	for (const line of luaOpeners)
	{
		assert.strictEqual(onEnter(lua, line, ""), "indent", "Lua, indent after: " + line);
		if (!line.endsWith("{"))
		{
			assert.strictEqual(onEnter(lua, line, "end"), "indentOutdent", "Lua, before end: " + line);
		}
		else
		{
			assert.strictEqual(onEnter(lua, line, "}"), "indentOutdent", "Lua, before }: " + line);
		}
	}
	// Words that are keywords only in Pluto are plain names in Lua.
	for (const line of ["class = 5", "class A", "switch(x)", "try = 1", "local x = 1", "-- do it", "if x then return end", "function f() end"])
	{
		assert.strictEqual(onEnter(lua, line, ""), undefined, "Lua, no indent after: " + line);
		assert.strictEqual(inc(lua, line), false, line);
	}
	assert.strictEqual(dec(lua, "end") && dec(lua, "else") && dec(lua, "until x") && dec(lua, "}"), true);

	// Both configurations are contributed: Pluto's for .pluto, the Lua one for .lua.
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	const luaLanguage = pkg.contributes.languages.find(l => l.id == "lua");
	assert(luaLanguage && luaLanguage.configuration == "./language-config-lua.json");
	assert(fs.existsSync(path.join(root, "language-config-lua.json")));
	assert.deepStrictEqual(pkg.contributes.languages.find(l => l.id == "pluto").extensions, [".pluto"]);
});

test("language configuration and manifest are consistent", function ()
{
	const root = path.join(__dirname, "..");
	const langConfig = JSON.parse(fs.readFileSync(path.join(root, "language-config.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
	const inc = new RegExp(langConfig.indentationRules.increaseIndentPattern);
	const dec = new RegExp(langConfig.indentationRules.decreaseIndentPattern);
	for (const line of ["function foo()", "if x then", "for i = 1, 10 do", "while x do", "class Foo", "class Foo extends Bar", "switch x do", "try", "\tfunction method()", "local function f()"])
	{
		assert(inc.test(line), "should indent after: " + line);
	}
	for (const line of ["end", "\tend", "else", "elseif x then", "catch e then", "until x"])
	{
		assert(dec.test(line), "should outdent: " + line);
	}
	for (const rule of langConfig.onEnterRules)
	{
		new RegExp(rule.beforeText);
	}
	new RegExp(langConfig.folding.markers.start);

	// The TextMate preferences must carry the same patterns.
	const tm = fs.readFileSync(path.join(root, "Pluto.tmbundle", "Preferences", "Indentation Rules.tmPreferences"), "utf8");
	const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
	const strings = [...tm.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(m => unescape(m[1]));
	assert(strings.includes(langConfig.indentationRules.increaseIndentPattern), "increaseIndentPattern out of sync");
	assert(strings.includes(langConfig.indentationRules.decreaseIndentPattern), "decreaseIndentPattern out of sync");

	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	assert(fs.existsSync(path.join(root, pkg.main)), "main entry point exists");
	assert(pkg.activationEvents.includes("onLanguage:pluto"));
	for (const contribution of [...pkg.contributes.snippets, ...pkg.contributes.grammars])
	{
		assert(fs.existsSync(path.join(root, contribution.path)), contribution.path);
	}
	for (const command of pkg.contributes.commands)
	{
		assert(pkg.activationEvents.includes("onCommand:" + command.command), command.command);
	}

	// Snippet files must be valid JSON-with-comments and provide the documented prefixes.
	const prefixes = new Set();
	for (const contribution of pkg.contributes.snippets)
	{
		const raw = fs.readFileSync(path.join(root, contribution.path), "utf8");
		const snippets = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
		for (const snippet of Object.values(snippets))
		{
			assert(snippet.body !== undefined, "snippet without body in " + contribution.path);
			for (const prefix of [].concat(snippet.prefix))
			{
				prefixes.add(prefix);
			}
		}
	}
	for (const prefix of ["class", "cls_ext", "fn", "switch", "try", "fori", "forp"])
	{
		assert(prefixes.has(prefix), "missing snippet prefix " + prefix);
	}
});

// ---------------------------------------------------------------------------------------------
// Workspace filtering: ignore files and exclude patterns
// ---------------------------------------------------------------------------------------------

const { IgnoreMatcher, GlobSet } = require("../src/ignore");

test("ignore files: .gitignore syntax", function ()
{
	const m = new IgnoreMatcher().add([
		"# comment",
		"build/",
		"*.log",
		"/root.pluto",
		"vendor/**",
		"!vendor/keep.pluto",
		"docs/**/gen.lua",
		"\\#hash.pluto",
		"\\!bang.pluto",
		"trailing.pluto   ",
		"tmp",
		"!tmp/x.pluto",
		"lib/*",
		"!lib/main.pluto",
		"*.gen.pluto",
		"!keep.gen.pluto",
		"file?.pluto",
		"[abc]x.pluto",
	].join("\n"));
	const expectations = {
		"build/a.pluto": true, "src/build/a.pluto": true, "buildx/a.pluto": false,
		"a.log": true, "x/a.log": true,
		"root.pluto": true, "src/root.pluto": false,
		"vendor/a.pluto": true, "vendor/keep.pluto": false,
		"docs/gen.lua": true, "docs/a/b/gen.lua": true, "gen.lua": false,
		"#hash.pluto": true, "!bang.pluto": true, "trailing.pluto": true,
		"tmp/x.pluto": true, // a file inside an excluded directory can't be re-included
		"lib/a.pluto": true, "lib/main.pluto": false, "lib/sub/a.pluto": true,
		"x.gen.pluto": true, "keep.gen.pluto": false, "src/keep.gen.pluto": false,
		"file1.pluto": true, "file12.pluto": false,
		"ax.pluto": true, "dx.pluto": false,
		"src/main.pluto": false,
	};
	for (const [p, expected] of Object.entries(expectations))
	{
		assert.strictEqual(m.ignores(p), expected, p);
	}
	// Patterns of an ignore file in a subdirectory are relative to that directory.
	const sub = new IgnoreMatcher().add("/gen.pluto\n*.tmp.pluto", "tools");
	assert.strictEqual(sub.ignores("tools/gen.pluto"), true);
	assert.strictEqual(sub.ignores("gen.pluto"), false);
	assert.strictEqual(sub.ignores("tools/deep/gen.pluto"), false);
	assert.strictEqual(sub.ignores("tools/deep/a.tmp.pluto"), true);
	assert.strictEqual(sub.ignores("a.tmp.pluto"), false);
});

test("exclude globs: VS Code syntax", function ()
{
	const g = new GlobSet(["**/node_modules", "*.lua", "out/**", "**/*.{gen,tmp}.pluto", "**/vendor/**", "{a,b}/**", "", 42]);
	const expectations = {
		"node_modules/a.pluto": true, "x/node_modules/y/a.pluto": true,
		"a.lua": true, "src/a.lua": false,
		"out/a.pluto": true, "src/out/a.pluto": false,
		"a.gen.pluto": true, "x/y/a.tmp.pluto": true, "a.pluto": false,
		"vendor/x.pluto": true, "lib/vendor/x.pluto": true,
		"a/x.pluto": true, "b/c/x.pluto": true, "c/x.pluto": false,
	};
	for (const [p, expected] of Object.entries(expectations))
	{
		assert.strictEqual(g.matches(p), expected, p);
	}
	assert.strictEqual(new GlobSet([]).matches("anything.pluto"), false);
});

test("index: excluded files are invisible to other files but work on their own", function ()
{
	const idx = new WorkspaceIndex();
	const an = new Analyzer(idx);
	const svc = {
		index: idx,
		analyzer: an,
		getRecord(document)
		{
			const excluded = document.uri.path.includes("/vendor/");
			const record = idx.setFile(document.uri.toString(), document.uri.fsPath, document.getText(), excluded);
			idx.setCurrent(record);
			return record;
		},
	};
	const p = createProviders(svc);
	idx.setFile("file:///ws/lib/shared.pluto", "/ws/lib/shared.pluto", "function sharedFn(a) end\n");
	const vendorText = "class VendorThing\n  function go(x) end\nend\nfunction vendorFn(b: number) end\n";
	idx.setFile("file:///ws/vendor/lib.pluto", "/ws/vendor/lib.pluto", vendorText, true);

	// From a normal file: vendor symbols are not offered, resolved or navigable.
	const main = vscode.createDocument("/ws/main.pluto", "vendorFn(1)\nsharedFn(1)\n");
	const items = p.completionProvider.provideCompletionItems(main, new vscode.Position(2, 0), null, { triggerKind: 0 });
	const labels = items.filter(i => i.kind != vscode.CompletionItemKind.Text).map(i => i.label);
	assert(labels.includes("sharedFn"));
	assert(!labels.includes("vendorFn") && !labels.includes("VendorThing"), "excluded symbols must not be suggested");
	assert.strictEqual(p.hoverProvider.provideHover(main, new vscode.Position(0, 3)), undefined);
	assert.strictEqual(p.definitionProvider.provideDefinition(main, new vscode.Position(0, 3)), undefined);
	assert.strictEqual(p.signatureProvider.provideSignatureHelp(main, new vscode.Position(0, 9)), undefined);
	assert(p.definitionProvider.provideDefinition(main, new vscode.Position(1, 3)), "included files still resolve");
	assert.strictEqual(idx.resolveModule("vendor.lib"), null, "require() can't reach excluded files");

	// From the excluded file itself: its own declarations work, and it still sees the workspace.
	const vendorDoc = vscode.createDocument("/ws/vendor/lib.pluto", vendorText + "vendorFn(1)\nlocal v = new VendorThing()\nv:go(1)\nsharedFn(1)\n");
	assert(p.hoverProvider.provideHover(vendorDoc, new vscode.Position(4, 3)).contents[0].value.includes("function vendorFn(b: number)"));
	assert.strictEqual(p.definitionProvider.provideDefinition(vendorDoc, new vscode.Position(4, 3))[0].range.start.line, 3);
	const own = p.completionProvider.provideCompletionItems(vendorDoc, new vscode.Position(6, 2), null, { triggerKind: 1, triggerCharacter: ":" });
	assert.deepStrictEqual(own.map(i => i.label), ["go"]);
	assert(p.definitionProvider.provideDefinition(vendorDoc, new vscode.Position(7, 3)));

	// Back in the normal file, the excluded file's symbols are gone again.
	assert.strictEqual(p.hoverProvider.provideHover(main, new vscode.Position(0, 3)), undefined);
	assert.strictEqual(idx.lookup("vendorFn").length, 0);
});

/**
 * The real LanguageService against an in-memory workspace, for the end-to-end behaviour of
 * ignore files and settings. Returns helpers to change files and settings.
 */
function createFakeWorkspace(files)
{
	const disk = new Map(Object.entries(files));
	const toPath = (uri) => uri.path;
	vscode.workspace.fs = {
		async stat(uri)
		{
			if (!disk.has(toPath(uri)))
			{
				throw new Error("ENOENT");
			}
			return { size: disk.get(toPath(uri)).length };
		},
		async readFile(uri)
		{
			if (!disk.has(toPath(uri)))
			{
				throw new Error("ENOENT");
			}
			return Buffer.from(disk.get(toPath(uri)));
		},
	};
	vscode.workspace.findFiles = async function (include)
	{
		const exts = include.includes("info.json") ? /\/info\.json$/ : include.includes("lua") ? /\.(pluto|lua)$/ : /\.pluto$/;
		return [...disk.keys()].filter(p => exts.test(p)).map(p => vscode.Uri.file(p));
	};
	vscode.workspace.textDocuments = [];
	return { disk };
}

const asyncTests = [];
test("hover/definition: built-in types in type hints are not looked up as fields", function ()
{
	const readers = vscode.Uri.file("/ws/lib/readers.pluto").toString();
	index.setFile(readers, "/ws/lib/readers.pluto", "local READERS = {}\nREADERS.int = function(x) end\nREADERS.bool = 1\nKIND_OF_TYPE = { int = 1 }\nreturn READERS\n");
	try
	{
		for (const text of [
			"function spawn(ped: i|nt = 0) end",
			"function spawn(ped): b|ool end",
			"local count: i|nt = 0",
			"class Car\n    public speed: flo|at = 0\nend",
		])
		{
			const h = hover(text);
			assert(h && h.includes("(type) " + /\w*\|\w*/.exec(text)[0].replace("|", "")), text + " → " + h);
			assert(!/READERS|KIND_OF_TYPE|function\(x\)/.test(h), text + " → " + h);
			assert.strictEqual(definition(text), undefined, text);
		}
		// Unions, lambdas and `->` (the test cursor marker can't be used next to `|`).
		const typeAt = (line, word) => typeAnnotationAt(line, line.lastIndexOf(word), line.lastIndexOf(word) + word.length);
		assert.deepStrictEqual(typeAt("function spawn(ped: string|int) end", "int"), { word: "int", primitive: true });
		assert.deepStrictEqual(typeAt("function spawn(ped: string | ?int) end", "int"), { word: "int", primitive: true, nullable: true, leadingQ: true, trailingQ: false });
		assert.deepStrictEqual(typeAt("function spawn(ped: int?, b) end", "int"), { word: "int", primitive: true, nullable: true, leadingQ: false, trailingQ: true });
		assert.deepStrictEqual(typeAt("function spawn(ped: int | string?) end", "int"), { word: "int", primitive: true });
		assert.deepStrictEqual(typeAt("function spawn(ped): Car?", "Car"), { word: "Car", primitive: false, nullable: true, leadingQ: false, trailingQ: true, returnType: true });
		assert.deepStrictEqual(typeAt("function spawn(ped) : int", "int"), { word: "int", primitive: true, returnType: true });
		assert.deepStrictEqual(typeAt("local f = |x: number| -> bool", "bool"), { word: "bool", primitive: true, returnType: true });
		assert.deepStrictEqual(typeAt("function spawn(ped): ?string|int", "int"), { word: "int", primitive: true, returnType: true });
		assert.deepStrictEqual(typeAt("local f = |x: number| -> bool", "number"), { word: "number", primitive: true });
		assert.strictEqual(typeAt("local f = |x| -> x", "x"), null);
		assert.strictEqual(typeAt("local z = a | int", "int"), null);
		assert.strictEqual(typeAt("obj:int()", "int"), null);
		assert.strictEqual(typeAt("obj:int \"s\"", "int"), null);
		assert.strictEqual(typeAt("t.int", "int"), null);
		// A class used as a type resolves to the class, not to a member of the parameter.
		assert(hover("function greetAll(h: Hu|man) end").includes("class Human"));
		assert.strictEqual(definition("function greetAll(h: Hu|man) end")[0].uri.path, "/ws/lib/human.pluto");
		// Method calls are still method calls.
		assert(hover("local u = require(\"lib.util\")\nu:meth|od(1)").includes("method(x)"));
		assert(!hover("local h = new Human(\"x\")\nh:getN|ame()").includes("(type)"));
		// Field access and library calls are unaffected.
		assert(hover("print(READERS.i|nt)").includes("READERS"));
		assert(hover("local s = x and y or str|ing.format(\"\")").includes("library"));

		// Completion in type hints suggests types instead of members.
		for (const text of [
			"function spawn(ped: |",
			"function spawn(ped: i|",
			"function M.f(a, b: ?|",
			"function spawn(ped): |",
			"local x = function(x: |",
			"local x: i|",
			"local a: int, b: |",
			"class C\n    public name: |",
			"class C\n    name: |",
		])
		{
			const { labels } = complete(text);
			assert(labels.includes("int") && labels.includes("Human"), text + " → " + labels.join(", "));
			assert(!labels.includes("speak") && !labels.includes("split") && !labels.includes("greet"), text + " → " + labels.join(", "));
		}
		assert(complete("local h = new Human(\"x\")\nh:|").labels.includes("getName"));
		assert(complete("function Human:test()\n    self:|").labels.includes("getName"));
		assert(complete("print(READERS:|").labels.includes("int"));
	}
	finally
	{
		index.removeFile(readers);
	}
});

const { formatFunctionSource } = require("../src/functionSource");

test("function source: comments, spacing, indentation and blank lines", function ()
{
	const src = [
		"    function does_last_exist(): bool   -- is there one?",
		"        --- helper comment",
		"        local   handle = self:get_last_handle()  -- trailing",
		"        --[[ block",
		"           comment ]]",
		"",
		"",
		"        if handle == nil then",
		"            return false -- none",
		"        end",
		"        return Atdar.natives.entity.vehicle.does_exist(handle, \"a   --  b\")",
		"    end",
	].join("\n");
	assert.strictEqual(formatFunctionSource(src), [
		"function does_last_exist(): bool",
		"",
		"  local handle = self:get_last_handle()",
		"",
		"  if handle == nil then",
		"    return false",
		"  end",
		"",
		"  return Atdar.natives.entity.vehicle.does_exist(handle, \"a   --  b\")",
		"end",
	].join("\n"));

	// Short functions stay compact; tabs and odd indentation are normalized; trailing `,` is dropped.
	assert.strictEqual(formatFunctionSource("\tfoo = function(a)\n\t\t\t-- x\n\t\t\treturn a  +  1\n\tend,"), "foo = function(a)\n  return a + 1\nend");
	assert.strictEqual(formatFunctionSource("function M.add(a, b) return a + b end"), "function M.add(a, b) return a + b end");

	// Strings keep their contents, long strings included.
	assert.strictEqual(formatFunctionSource("function f()\n    return [[a\n  -- b]], '--'\nend"), "function f()\n  return [[a\n  -- b]], '--'\nend");

	// Short nested blocks stay tight, long ones are spaced; `else` stays with its `if`.
	const long = formatFunctionSource([
		"function g(x)",
		"    local a = 1",
		"    local b = 2",
		"    for i = 1, x do",
		"        print(i)",
		"        print(i)",
		"    end",
		"    if a then",
		"        print(1)",
		"    else",
		"        print(2)",
		"    end",
		"    return a",
		"end",
	].join("\n"));
	assert.strictEqual(long, [
		"function g(x)",
		"",
		"  local a = 1",
		"  local b = 2",
		"",
		"  for i = 1, x do",
		"    print(i)",
		"    print(i)",
		"  end",
		"",
		"  if a then",
		"    print(1)",
		"  else",
		"    print(2)",
		"  end",
		"",
		"  return a",
		"end",
	].join("\n"));

	// Line limit.
	const cut = formatFunctionSource(long, { maxLines: 5 });
	assert.strictEqual(cut, "function g(x)\n\n  local a = 1\n  local b = 2\n  -- ... (+14 lines)");
});

test("hover: shows the source of a function below a separator", function ()
{
	const body = hover("function greetAll(name: string)\n    -- say hello\n    print(\"hi\")\n    print(name)\n    return 1\nend\ngreet|All(\"x\")");
	assert(body.includes("---\n\n```pluto\nfunction greetAll(name: string)\n  print(\"hi\")\n  print(name)\n  return 1\nend\n```"), body);
	assert(!body.includes("say hello"));
	// Declarations of other open files, too; closed files are read from disk.
	const other = vscode.createDocument("/ws/lib/human.pluto", FILES["/ws/lib/human.pluto"]);
	vscode.workspace.textDocuments.push(other);
	try
	{
		const h = hover("local h = new Human(\"x\")\nh:getN|ame()");
		assert(h.includes("```pluto\nfunction getName(): string\n  return self.name\nend\n```"), h);
	}
	finally
	{
		vscode.workspace.textDocuments.pop();
	}
	// Settings.
	vscode.config["plua.hover.maxBodyLines"] = 2;
	vscode.config["plua.hover.showFunctionBody"] = true;
	assert(hover("function a()\n    print(1)\n    print(2)\n    print(3)\nend\n|a()").includes("-- ... (+"));
	vscode.config["plua.hover.showFunctionBody"] = false;
	assert(!hover("function a()\n    print(1)\nend\n|a()").includes("\n\n---\n\n"));
	delete vscode.config["plua.hover.showFunctionBody"];
	delete vscode.config["plua.hover.maxBodyLines"];
});

testAsync("hover: same-named members are told apart by the path of the chain", async function ()
{
	const natives = {
		"/ws/game/natives/camera.pluto": "local module = {}\nfunction module.does_exist(cam: int): bool\n    return true\nend\nreturn module\n",
		"/ws/game/natives/script.pluto": "local module = {}\nfunction module.does_exist(name: string): bool\n    return false\nend\nreturn module\n",
		"/ws/game/natives/entity.pluto": "local module = {}\nfunction module.does_exist(entity: int): bool\n    return true\nend\nreturn module\n",
		"/ws/game/natives/entity/vehicle.pluto": "local module = {}\nfunction module.does_exist(vehicle: int): bool\n    local is_entity = Atdar.natives.entity.does_exist(vehicle)\n    if not is_entity then\n        return false\n    end\n    return true\nend\nreturn module\n",
		"/ws/game/natives/entity/ped.lua": "local module = {}\nfunction module.does_exist(ped) return true end\nreturn module\n",
	};
	const keys = [];
	for (const [p, text] of Object.entries(natives))
	{
		const key = vscode.Uri.file(p).toString();
		keys.push(key);
		index.setFile(key, p, text);
	}
	// Bodies are read from open editors (the fixture files don't exist on disk).
	const open = vscode.createDocument("/ws/game/natives/entity/vehicle.pluto", natives["/ws/game/natives/entity/vehicle.pluto"]);
	vscode.workspace.textDocuments.push(open);
	const calls = [];
	vscode.commands = { executeCommand: async (...args) => { calls.push(args); } };
	try
	{
		const h = hover("local ok = Atdar.natives.entity.vehicle.does_ex|ist(h)");
		assert(h.includes("does_exist(vehicle: int)"), h);
		assert(!h.includes("cam: int") && !h.includes("name: string") && !h.includes("entity: int") && !h.includes("ped"), h);
		assert(h.includes("```pluto\nfunction module.does_exist(vehicle: int): bool\n\n  local is_entity"), h);
		assert(!h.includes("showDeclarations"), h);
		assert(h.includes("[$(preview) Peek Code](command:plua.peekCode?"), h);
		// Shorter paths, `.lua` files and the group file itself.
		assert(hover("Atdar.natives.entity.ped.does_ex|ist(h)").includes("does_exist(ped)"));
		const entity = hover("Atdar.natives.entity.does_ex|ist(h)");
		assert(entity.includes("does_exist(entity: int)") && !entity.includes("vehicle: int"), entity);
		assert(hover("Atdar.natives.camera.does_ex|ist(h)").includes("cam: int"));
		// Aliases: a local, and a field of `self`.
		assert(hover("local n_vehicle = Atdar.natives.entity.vehicle\nn_vehicle.does_ex|ist(h)").includes("vehicle: int"));
		const viaSelf = hover("class Garage\n    function __construct()\n        self.vehicles = Atdar.natives.entity.vehicle\n    end\n    function check(h)\n        return self.vehicles.does_ex|ist(h)\n    end\nend");
		assert(viaSelf.includes("does_exist(vehicle: int)") && !viaSelf.includes("cam: int"), viaSelf);
		assert.strictEqual(definition("Atdar.natives.entity.vehicle.does_ex|ist(h)").length, 1);
		assert(definition("Atdar.natives.entity.vehicle.does_ex|ist(h)")[0].uri.path.endsWith("natives/entity/vehicle.pluto"));

		// Unknown path: every declaration, listed with a link that opens them all.
		const all = hover("foo.bar.does_ex|ist(h)");
		assert(all.includes("cam: int") && all.includes("name: string") && all.includes("ped") && !all.includes("more declarations"), all);
		assert(all.includes("[Show all declarations (5)](command:plua.showDeclarations?"), all);
		const { document, position } = at("foo.bar.does_ex|ist(h)");
		const parts = providers.hoverProvider.provideHover(document, position).contents;
		const link = parts[parts.length - 1];
		assert.deepStrictEqual(link.isTrusted, { enabledCommands: ["plua.showDeclarations"] });
		const peekLink = parts[parts.length - 2];
		assert.deepStrictEqual(peekLink.isTrusted, { enabledCommands: ["plua.peekCode"] });
		assert(parts.slice(0, -2).every(md => !md.isTrusted), "only the generated links may be trusted");

		// The limit of the hover; the link still counts everything.
		vscode.config["plua.hover.maxDeclarations"] = 2;
		const some = providers.hoverProvider.provideHover(document, position).contents;
		assert.strictEqual(some.length, 4);
		assert(some[3].value.includes("(5)"));
		delete vscode.config["plua.hover.maxDeclarations"];

		// The command behind the link opens the references peek with all of them.
		const args = JSON.parse(decodeURIComponent(/\?([^ )]+)/.exec(link.value)[1]));
		vscode.workspace.textDocuments.push(document);
		await providers.showDeclarations(...args);
		vscode.workspace.textDocuments.pop();
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0][0], "editor.action.showReferences");
		assert.strictEqual(calls[0][3].length, 5);

		// "Peek Code": the wide peek widget through goToLocations, even for a single definition.
		const peekArgs = JSON.parse(decodeURIComponent(/\?([^ )]+)/.exec(peekLink.value)[1]));
		assert.strictEqual(peekArgs[0], document.uri.toString());
		calls.length = 0;
		const target = new vscode.Location(vscode.Uri.file("/ws/a.pluto"), new vscode.Position(1, 2));
		vscode.commands = { executeCommand: async (...a) => { calls.push(a); return a[0] == "vscode.executeDefinitionProvider" ? [target] : undefined; } };
		await providers.peekCode(...peekArgs);
		assert.strictEqual(calls[0][0], "vscode.executeDefinitionProvider");
		assert.strictEqual(calls[1][0], "editor.action.goToLocations");
		assert.strictEqual(calls[1][4], "peek");
		assert.deepStrictEqual(calls[1][3], [target]);
		calls.length = 0;
		vscode.commands = { executeCommand: async (...a) => { calls.push(a); return []; } };
		await providers.peekCode(...peekArgs);
		assert.strictEqual(calls.length, 1, "nothing to peek: no widget");
	}
	finally
	{
		vscode.workspace.textDocuments.splice(vscode.workspace.textDocuments.indexOf(open), 1);
		delete vscode.commands;
		for (const key of keys)
		{
			index.removeFile(key);
		}
	}
});

const { findNullableTypes, isTypeHintPosition, describeNullable, isNullableType } = require("../src/typeHints");

test("nullable types: finding them in a source file", function ()
{
	const src = [
		"function spawn(ped: int?, name: string, model: ?string): Vehicle?",   // 0
		"    local x: Foo.Bar? = nil",                                         // 1
		"    local y: number|nil, z: bool? = 1, true",                          // 2
		"    local ok = obj:method(a?) and cond ? a : b",                       // 3
		"end",                                                                 // 4
		"class Car",                                                           // 5
		"    public owner: Person?",                                           // 6
		"    wheels: int?",                                                    // 7
		"end",                                                                 // 8
		"function multi(",                                                     // 9
		"    first: Thing?,",                                                  // 10
		"    second: int",                                                     // 11
		"): string?",                                                          // 12
		"end",                                                                 // 13
		"local s = \"a: int?\" -- b: string?",                                  // 14
		"switch x do",                                                         // 15
		"    default: print(1)",                                               // 16
		"end",                                                                 // 17
	].join("\n");
	const found = findNullableTypes(src);
	assert.deepStrictEqual(found.map(f => [f.line, f.text]), [
		[0, "int?"], [0, "?string"], [0, "Vehicle?"],
		[1, "Foo.Bar?"],
		[2, "bool?"],
		[6, "Person?"],
		[7, "int?"],
		[10, "Thing?"],
		[12, "string?"],
	]);
	const first = found[0];
	assert.deepStrictEqual([first.col, first.endCol], [20, 24]);
	assert.strictEqual(src.split("\n")[first.line].slice(first.col, first.endCol), "int?");

	assert.strictEqual(isNullableType("int?") && isNullableType("?int") && isNullableType("string|int?"), true);
	assert.strictEqual(isNullableType("int") || isNullableType("int|nil") || isNullableType(undefined), false);
	assert.deepStrictEqual(describeNullable("?string"), { title: "(nullable type) ?string", text: "Can be `string` or `nil` (optional / nullable)" });
});

test("type hints: where completion opens", function ()
{
	for (const yes of ["function f(a: ", "function f(a, b:", "function f(a): ", "local x: ", "local a: int, b: ", "public name: ", "    name: ", "function f(a: int|", "function f(a: ?"])
	{
		assert.strictEqual(isTypeHintPosition(yes), true, yes);
	}
	for (const no of ["obj:", "self:", "foo(obj:", "local ok = a ? b : ", "    default: ", "case 1: ", "x = t:", "function f(a: int) return obj:", "function f(a: int) "])
	{
		assert.strictEqual(isTypeHintPosition(no), false, no);
	}
});

test("type completion: built-in and nullable types, classes, Pluto files only", function ()
{
	const labels = complete("function f(a: |").labels;
	for (const name of ["int", "int?", "number?", "float?", "string?", "bool?", "table?", "function?", "userdata?", "void", "any", "mixed", "Human", "Human?", "Color", "Color?"])
	{
		assert(labels.includes(name), name + " in " + labels.join(" "));
	}
	for (const name of ["void?", "any?", "mixed?", "nil?", "speak", "split"])
	{
		assert(!labels.includes(name), name);
	}
	const items = complete("local x: |");
	assert.strictEqual(items.get("Human").kind, vscode.CompletionItemKind.Class);
	assert.strictEqual(items.get("Human?").kind, vscode.CompletionItemKind.Class);
	assert.strictEqual(items.get("Human?").detail, "(nullable type) Human?");
	assert.strictEqual(items.get("int?").detail, "(nullable type) int?");
	assert(items.get("int?").documentation.value.includes("Can be `int` or `nil`"));
	assert(items.labels.indexOf("int?") == items.labels.indexOf("int") + 1 || items.get("int?").sortText > items.get("int").sortText);

	// Typing `:` or a space opens the list in a type hint and nowhere else.
	const typed = (text, ch) => complete(text, { triggerKind: 1, triggerCharacter: ch }).labels;
	assert(typed("function f(a:|", ":").includes("int?"));

	// `text:` without a space: the chosen type brings the space, so the result is `text: bool`.
	for (const text of ["function f(text:|", "function f(text:b|", "local text:|", "function f(): void\nfunction g(a, text:|"])
	{
		const list = complete(text);
		for (const label of ["bool", "int?", "string", "Human", "Human?"])
		{
			assert.strictEqual(list.get(label).insertText, " " + label, text + " → " + label);
			assert.strictEqual(list.get(label).filterText, label);
		}
	}
	// With a space already there nothing is added.
	for (const text of ["function f(text: |", "function f(text: b|", "local text:  |"])
	{
		const list = complete(text);
		assert.strictEqual(list.get("bool").insertText, undefined, text);
		assert.strictEqual(list.get("Human?").insertText, undefined, text);
	}
	assert(typed("function f(a: |", " ").includes("int?"));
	assert(typed("function f(): |", " ").includes("string?"));
	assert.deepStrictEqual(typed("local x = 1 |", " "), []);
	assert.deepStrictEqual(typed("print(1) |", " "), []);
	assert.deepStrictEqual(typed("switch x do\n    default: |", " "), []);
	assert(!typed("local h = new Human(\"x\")\nh:|", ":").includes("int?"));
	assert(typed("local h = new Human(\"x\")\nh:|", ":").includes("getName"));
	vscode.config["plua.completion.autoTriggerTypes"] = false;
	assert.deepStrictEqual(typed("function f(a: |", " "), []);
	assert.deepStrictEqual(typed("function f(a:|", ":"), []);
	assert(complete("function f(a: |").labels.includes("int?"), "Ctrl+Space still works");
	delete vscode.config["plua.completion.autoTriggerTypes"];

	// Not in Lua files.
	const lua = vscode.createDocument("/ws/x.lua", "local x: ", "lua");
	const offered = providers.completionProvider.provideCompletionItems(lua, new vscode.Position(0, 9), null, { triggerKind: 0 }) || [];
	assert(!offered.some(i => i.label == "int?"));
	assert.deepStrictEqual(providers.completionProvider.provideCompletionItems(lua, new vscode.Position(0, 9), null, { triggerKind: 1, triggerCharacter: " " }) || [], []);
});

test("hover and signature help: nullable types", function ()
{
	const onInt = hover("function f(ped: in|t?) end");
	assert(onInt.includes("(nullable type) int?") && onInt.includes("Can be `int` or `nil` (optional / nullable)"), onInt);
	assert(!onInt.includes("(type) int") && !onInt.includes("Integer number"), onInt);
	assert(hover("function f(ped: ?str|ing) end").includes("(nullable type) ?string"));
	assert(hover("function f(ped): bo|ol?\nend").includes("(nullable type) bool?"));
	const cls = hover("function f(h: Hum|an?) end");
	assert(cls.includes("(nullable type) Human?") && cls.includes("class Human"), cls);
	// A plain type keeps its usual tip.
	assert(hover("function f(ped: in|t) end").includes("(type) int"));
	// The hover covers the question mark.
	const range = (text) => { const { document, position } = at(text); return providers.hoverProvider.provideHover(document, position).range; };
	let r = range("function f(ped: in|t?) end");
	assert.deepStrictEqual([r.start.character, r.end.character], [16, 20]);
	r = range("function f(ped: ?in|t) end");
	assert.deepStrictEqual([r.start.character, r.end.character], [16, 20]);

	// Signature help notes nullable parameters; they count as optional.
	const sig = signature("function nf(a: int?, b: string, c: ?Human)\nend\nnf(|");
	const params = sig.signatures[0].parameters;
	assert.strictEqual(sig.signatures[0].label, "nf(a: int?, b: string, c: ?Human)");
	assert(params[0].documentation.value.includes("(nullable type) int?") && params[0].documentation.value.includes("Can be `int` or `nil`"));
	assert.strictEqual(params[1].documentation, undefined);
	assert(params[2].documentation.value.includes("(nullable type) ?Human"));
	const parsed = parse("function nf(a: int?, b: string) end").symbols[0].params;
	assert.deepStrictEqual(parsed.map(p => p.optional === true), [true, false]);
});

test("type hints in the editor: the list opens by itself, nullable types are highlighted", function ()
{
	const { triggerTypeSuggest, NullableHighlighter } = require("../src/typeEditor");
	const commands = [];
	vscode.commands = { executeCommand: (...args) => { commands.push(args[0]); } };
	const makeEditor = (document, line, character) => ({ document, selections: [{}], selection: { active: new vscode.Position(line, character) } });
	const change = (document, text, line, character, extra) => ({ document, contentChanges: [{ text, rangeLength: 0, range: new vscode.Range(line, character, line, character) }], ...extra });
	try
	{
		// `function f(a:` just typed.
		let doc = vscode.createDocument("/ws/m.pluto", "function f(a:", "pluto");
		vscode.window.activeTextEditor = makeEditor(doc, 0, 13);
		assert.strictEqual(triggerTypeSuggest(change(doc, ":", 0, 12)), true);
		assert.deepStrictEqual(commands, ["editor.action.triggerSuggest"]);
		// A space after the colon, and after a union bar.
		doc = vscode.createDocument("/ws/m.pluto", "function f(a: ", "pluto");
		vscode.window.activeTextEditor = makeEditor(doc, 0, 14);
		assert.strictEqual(triggerTypeSuggest(change(doc, " ", 0, 13)), true);
		// Method calls and other code never open it.
		for (const [text, typedAt] of [["obj:", 3], ["self:", 4], ["foo(obj:", 7], ["local ok = a ? b :", 17], ["    default:", 11]])
		{
			doc = vscode.createDocument("/ws/m.pluto", text, "pluto");
			vscode.window.activeTextEditor = makeEditor(doc, 0, text.length);
			assert.strictEqual(triggerTypeSuggest(change(doc, ":", 0, typedAt)), false, text);
		}
		doc = vscode.createDocument("/ws/m.pluto", "local x = 1 ", "pluto");
		vscode.window.activeTextEditor = makeEditor(doc, 0, 12);
		assert.strictEqual(triggerTypeSuggest(change(doc, " ", 0, 11)), false);
		// Not in Lua files, not when switched off, not for undo, not when the cursor is elsewhere.
		const lua = vscode.createDocument("/ws/m.lua", "function f(a:", "lua");
		vscode.window.activeTextEditor = makeEditor(lua, 0, 13);
		assert.strictEqual(triggerTypeSuggest(change(lua, ":", 0, 12)), false);
		doc = vscode.createDocument("/ws/m.pluto", "function f(a:", "pluto");
		vscode.window.activeTextEditor = makeEditor(doc, 0, 13);
		assert.strictEqual(triggerTypeSuggest(change(doc, ":", 0, 12, { reason: vscode.TextDocumentChangeReason.Undo })), false);
		vscode.window.activeTextEditor = makeEditor(doc, 0, 5);
		assert.strictEqual(triggerTypeSuggest(change(doc, ":", 0, 12)), false);
		vscode.window.activeTextEditor = makeEditor(doc, 0, 13);
		vscode.config["plua.completion.autoTriggerTypes"] = false;
		assert.strictEqual(triggerTypeSuggest(change(doc, ":", 0, 12)), false);
		delete vscode.config["plua.completion.autoTriggerTypes"];
		assert.strictEqual(commands.length, 2);

		// Highlight: decoration with the configured colors, applied to Pluto editors only.
		const types = [];
		vscode.window.createTextEditorDecorationType = (options) => { const type = { options, disposed: false, dispose() { this.disposed = true; } }; types.push(type); return type; };
		const applied = [];
		const pEditor = { document: vscode.createDocument("/ws/n.pluto", "function f(a: int?, b: string): Car?\nend", "pluto"), setDecorations: (type, ranges) => applied.push(["pluto", type, ranges]) };
		const lEditor = { document: vscode.createDocument("/ws/n.lua", "function f(a: int?)\nend", "lua"), setDecorations: () => applied.push(["lua"]) };
		vscode.window.visibleTextEditors = [pEditor, lEditor];
		const highlighter = new NullableHighlighter();
		assert.strictEqual(types.length, 1);
		assert.deepStrictEqual(types[0].options, { color: "#FFFFFF", dark: { color: "#FFFFFF" }, light: { color: "#000000" } });
		assert.deepStrictEqual(applied.map(a => a[0]), ["pluto"]);
		assert.deepStrictEqual(applied[0][2].map(r => [r.start.line, r.start.character, r.end.character]), [[0, 14, 18], [0, 32, 36]]);
		// New colors and switching off.
		vscode.config["plua.highlight.nullableTypeColor"] = "#EEEEEE";
		highlighter.rebuild();
		assert(types[0].disposed && types.length == 2 && types[1].options.dark.color == "#EEEEEE");
		vscode.config["plua.highlight.nullableTypes"] = false;
		highlighter.rebuild();
		assert(types[1].disposed && highlighter.type === null);
		const before = applied.length;
		highlighter.apply(pEditor);
		assert.strictEqual(applied.length, before);
		highlighter.dispose();
	}
	finally
	{
		delete vscode.commands;
		delete vscode.window.activeTextEditor;
		delete vscode.window.createTextEditorDecorationType;
		delete vscode.window.visibleTextEditors;
		delete vscode.config["plua.highlight.nullableTypeColor"];
		delete vscode.config["plua.highlight.nullableTypes"];
	}
});

const i18n = require("../src/i18n");

test("i18n: the language is detected from the editor and can be fixed by hand", function ()
{
	const { resolveLanguage } = i18n;
	// auto: Russian for any Russian display language, English for everything else
	for (const ru of ["ru", "ru-RU", "ru_RU", "RU", "ru-ua"])
	{
		assert.strictEqual(resolveLanguage("auto", ru), "ru", ru);
	}
	for (const other of ["en", "en-US", "en-GB", "de", "uk", "pl", "zh-cn", "russian", "", undefined, null])
	{
		assert.strictEqual(resolveLanguage("auto", other), "en", String(other));
	}
	// missing or unknown settings behave like auto
	assert.strictEqual(resolveLanguage(undefined, "ru"), "ru");
	assert.strictEqual(resolveLanguage("klingon", "ru-RU"), "ru");
	assert.strictEqual(resolveLanguage("klingon", "fr"), "en");
	// a fixed language wins over the editor's
	assert.strictEqual(resolveLanguage("en", "ru-RU"), "en");
	assert.strictEqual(resolveLanguage("ru", "en-US"), "ru");
	assert.strictEqual(resolveLanguage("ru", undefined), "ru");
});

test("i18n: applyLanguage reads plua.language and vscode.env.language, and switches on the fly", function ()
{
	const { applyLanguage } = require("../src/extension");
	try
	{
		vscode.env = { language: "ru-RU" };
		assert.strictEqual(applyLanguage(), "ru");
		assert.strictEqual(i18n.getLanguage(), "ru");
		assert.strictEqual(i18n.t("hover.line", 7), "Строка 7");
		vscode.config["plua.language"] = "en"; // pinned by hand, as `onDidChangeConfiguration` would pick up
		assert.strictEqual(applyLanguage(), "en");
		assert.strictEqual(i18n.t("hover.line", 7), "Line 7");
		vscode.env = { language: "en" };
		vscode.config["plua.language"] = "auto";
		assert.strictEqual(applyLanguage(), "en");
		vscode.config["plua.language"] = "ru";
		assert.strictEqual(applyLanguage(), "ru");
		delete vscode.config["plua.language"];
		vscode.env = { language: "de" };
		assert.strictEqual(applyLanguage(), "en");
		delete vscode.env; // a host without `env` is English
		assert.strictEqual(applyLanguage(), "en");
	}
	finally
	{
		delete vscode.env;
		delete vscode.config["plua.language"];
		i18n.setLanguage("en");
	}
});

test("i18n: the dictionaries are complete and the placeholders match", function ()
{
	const { MESSAGES, t, setLanguage } = i18n;
	const keys = (o) => Object.keys(o).sort();
	assert.deepStrictEqual(keys(MESSAGES.ru), keys(MESSAGES.en), "every message has a Russian and an English text");
	const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort().join(",");
	for (const key of Object.keys(MESSAGES.en))
	{
		assert.strictEqual(placeholders(MESSAGES.ru[key]), placeholders(MESSAGES.en[key]), key);
		assert(MESSAGES.en[key].trim() && MESSAGES.ru[key].trim(), key);
	}
	// every built-in type has a description
	for (const name of require("../src/analysis").PRIMITIVE_TYPES.keys())
	{
		assert(MESSAGES.en["type." + name] && MESSAGES.ru["type." + name], name);
	}
	// substitution, and what happens with unknown keys
	assert.strictEqual(t("status.indexed", 3, 2), "Pluto: indexed 3 files, 2 module manifests");
	assert.strictEqual(t("no.such.key"), "no.such.key");
	assert.strictEqual(t("hover.requires", "xml"), "Requires `local xml = require \"pluto:xml\"`");
	setLanguage("ru");
	try
	{
		assert.strictEqual(t("status.indexed", 3, 2), "Pluto: проиндексировано файлов — 3, манифестов модулей — 2");
		assert.strictEqual(t("no.such.key"), "no.such.key");
		setLanguage("fr"); // unknown languages mean English
		assert.strictEqual(i18n.getLanguage(), "en");
	}
	finally
	{
		setLanguage("en");
	}
});

// (asynchronous only to run after the diagnostics helpers further down have been set up)
testAsync("i18n: hovers, completion and diagnostics speak the chosen language", async function ()
{
	const russian = (fn) => { i18n.setLanguage("ru"); try { return fn(); } finally { i18n.setLanguage("en"); } };
	// hover on a built-in type and a nullable type
	assert(hover("function f(ped: in|t) end").includes("(type) int"));
	russian(function ()
	{
		const plain = hover("function f(ped: in|t) end");
		assert(plain.includes("(тип) int") && plain.includes("Целое число"), plain);
		const nullable = hover("function f(ped: in|t?) end");
		assert(nullable.includes("(допускающий nil) int?") && nullable.includes("Может быть `int` или `nil`"), nullable);
		assert(hover("local s = str|ing.format(\"\")").includes("(библиотека) string"));
		// completion of types
		const list = complete("function f(a: |");
		assert.strictEqual(list.get("int?").detail, "(допускающий nil) int?");
		assert.strictEqual(list.get("bool").detail, "(тип) bool");
		assert(list.get("bool").documentation.value.includes("Логический тип"));
	});
	// declarations link and source link in Russian
	index.setFile(vscode.Uri.file("/ws/lib/dup1.pluto").toString(), "/ws/lib/dup1.pluto", "local A = {}\nfunction A.same() end\n");
	index.setFile(vscode.Uri.file("/ws/lib/dup2.pluto").toString(), "/ws/lib/dup2.pluto", "local B = {}\nfunction B.same() end\n");
	try
	{
		assert(hover("x.y.sa|me()").includes("[Show all declarations (2)]"));
		russian(function ()
		{
			const h = hover("x.y.sa|me()");
			assert(h.includes("[Показать все объявления (2)]") && h.includes("Открыть список всех объявлений"), h);
			assert(h.includes("dup1.pluto:2"), h);
		});
	}
	finally
	{
		index.removeFile(vscode.Uri.file("/ws/lib/dup1.pluto").toString());
		index.removeFile(vscode.Uri.file("/ws/lib/dup2.pluto").toString());
	}
	// the same line number label inside one file
	russian(function ()
	{
		assert(hover("function sameFile()\nend\nsame|File()").includes("[Строка 1]"));
	});

	// diagnostics of the built-in checks
	const { lintSource, lintManifest } = require("../src/lint");
	const messages = () => [
		...lint("local m = require(\"nothing.here\")\ngreet()").map(p => p.message),
		...lintManifest("{ \"entry\": \"x.pluto\", \"dependencies\": [\"ghost\"] }", "/ws/mods/new/info.json", index, { exists: () => false }).map(p => p.message),
	];
	const en = messages();
	assert.deepStrictEqual(en, [
		"Module 'nothing.here' not found: no matching .pluto or .lua file in the workspace.",
		"'greet' expects at least 1 argument but got 0. Required: who.",
		"Missing required field 'id'.",
		"Entry file 'x.pluto' does not exist.",
		"Unknown dependency 'ghost': no info.json with this id in the workspace.",
	]);
	assert.deepStrictEqual(russian(messages), [
		"Модуль 'nothing.here' не найден: в рабочей области нет подходящего файла .pluto или .lua.",
		"'greet' ожидает минимум аргументов: 1, передано: 0. Обязательные: who.",
		"Отсутствует обязательное поле 'id'.",
		"Файл точки входа 'x.pluto' не существует.",
		"Неизвестная зависимость 'ghost': в рабочей области нет info.json с таким id.",
	]);
	assert.strictEqual(typeof lintSource, "function");

	// the truncated source of a function
	const { formatFunctionSource } = require("../src/functionSource");
	const code = "function g(x)\n    local a = 1\n    local b = 2\n    print(a)\n    print(b)\n    return a\nend";
	assert(formatFunctionSource(code, { maxLines: 3 }).endsWith("-- ... (+7 lines)"));
	assert(russian(() => formatFunctionSource(code, { maxLines: 3 })).endsWith("-- ... (+7 строк)"));
});

test("package.nls: every %key% of package.json has an English and a Russian text", function ()
{
	const root = path.join(__dirname, "..");
	const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
	const pkg = read("package.json");
	const en = read("package.nls.json");
	const ru = read("package.nls.ru.json");
	assert.deepStrictEqual(Object.keys(ru).sort(), Object.keys(en).sort(), "the two files have the same keys");

	// all %keys% used in the manifest
	const used = new Set();
	(function walk(value)
	{
		if (typeof value == "string")
		{
			const m = /^%(.+)%$/.exec(value);
			if (m) { used.add(m[1]); }
		}
		else if (value && typeof value == "object")
		{
			Object.values(value).forEach(walk);
		}
	})(pkg);
	for (const key of used)
	{
		assert(en[key] && ru[key], "missing text for %" + key + "%");
	}
	assert.deepStrictEqual([...used].sort(), Object.keys(en).sort(), "no unused texts");

	// nothing readable is left untranslated in the manifest: all texts of settings and commands are %keys%
	for (const [id, p] of Object.entries(pkg.contributes.configuration.properties))
	{
		for (const field of ["description", "markdownDescription", "markdownDeprecationMessage"])
		{
			if (p[field]) { assert(/^%.+%$/.test(p[field]), id + "." + field); }
		}
		(p.enumDescriptions || []).forEach((d, i) => assert(/^%.+%$/.test(d), id + ".enumDescriptions." + i));
		assert(p.description || p.markdownDescription, id + " is described");
	}
	for (const c of pkg.contributes.commands)
	{
		assert(/^%.+%$/.test(c.title), c.command);
	}
	for (const field of ["displayName", "description"])
	{
		assert(/^%.+%$/.test(pkg[field]), field);
	}

	// the language setting
	const language = pkg.contributes.configuration.properties["plua.language"];
	assert.deepStrictEqual(language.enum, ["auto", "en", "ru"]);
	assert.strictEqual(language.default, "auto");
	assert.strictEqual(language.enumDescriptions.length, 3);
	// the Russian texts are real Russian, the English ones are not
	for (const [key, text] of Object.entries(ru))
	{
		if (key != "displayName" && key != "config.title")
		{
			assert(/[А-Яа-яЁё]/.test(text), "not translated: " + key);
		}
	}
	// the files travel with the extension
	const ignore = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8");
	assert(!/nls/.test(ignore));
});

const { collectReturnTags, splitReturnTag, describeReturnType } = require("../src/returnTags");

test("@return tags: parsing", function ()
{
	const builtin = (n) => ["void", "bool", "int", "string", "nil"].includes(n);
	assert.deepStrictEqual(splitReturnTag("void Done when all are gone", "void", builtin), { type: "void", text: "Done when all are gone" });
	assert.deepStrictEqual(splitReturnTag("Just a description", "void", builtin), { type: null, text: "Just a description" });
	assert.deepStrictEqual(splitReturnTag("?string|nil - maybe a name", "string", builtin), { type: "?string|nil", text: "maybe a name" });
	assert.deepStrictEqual(splitReturnTag("Human the new human", "Human", builtin), { type: "Human", text: "the new human" });
	assert.deepStrictEqual(splitReturnTag("bool", "bool", builtin), { type: "bool", text: "" });
	assert.deepStrictEqual(splitReturnTag("nil when it can't be told", "string|nil", builtin), { type: null, text: "nil when it can't be told" });

	const lines = [
		"--- @return bool above",           // 0 (doc, via sym.doc)
		"function outer(): bool",             // 1
		"    -- @return Description in body", // 2
		"    local f = function()",           // 3
		"        -- @return string inner",    // 4
		"    end",                            // 5
		"    --@returns bool plural form",    // 6
		"    return true",                    // 7
		"end",                                // 8
	];
	const tags = collectReturnTags({ doc: "@return bool above", line: 1, endLine: 8, returnType: "bool" }, lines, [{ line: 3, endLine: 5 }], builtin);
	assert.deepStrictEqual(tags.map(t => [t.source, t.type, t.text]), [
		["doc", "bool", "above"],
		["body", null, "Description in body"],
		["body", "bool", "plural form"],
	]);
	// A description is picked by the type under the cursor; a single tag answers for any type.
	const two = [{ type: "int", text: "the count" }, { type: "string", text: "an error" }];
	assert.strictEqual(describeReturnType(two, "string"), "an error");
	assert.strictEqual(describeReturnType(two, "bool"), null);
	assert.strictEqual(describeReturnType([{ type: null, text: "anything" }], "bool"), "anything");
});

test("hover/signature: @return written by the developer", function ()
{
	const src = (extra) => [
		"--- Removes every vehicle.",
		"function remove_all_vehicles(): void",
		"    -- @return void Nothing; vehicles are deleted one by one",
		"    print(1)",
		"end",
		"function plain(): bool",
		"    -- @return Whether it worked",
		"    return true",
		"end",
		"--- @return string The name",
		"function named(): string return \"x\" end",
		"function bare(): int return 1 end",
		"class Box",
		"end",
		"function make(): Box",
		"    -- @return Box The new box",
		"    return new Box()",
		"end",
		"function nested(): int",
		"    local f = function(): bool",
		"        -- @return Inner only",
		"        return true",
		"    end",
		"    return 1",
		"end",
		extra,
	].join("\n");
	const h = (marked) => hover(src(marked));

	// Built-in type: the reference stays, the developer's text follows below.
	const void_ = h("function again(): vo|id end");
	assert(!void_.includes("Nothing"));
	const onVoid = hover(src("") .replace("function remove_all_vehicles(): void", "function remove_all_vehicles(): vo|id"));
	assert(onVoid.includes("(type) void") && onVoid.includes("No return value."), onVoid);
	assert(onVoid.indexOf("**@return** Nothing; vehicles are deleted one by one") > onVoid.indexOf("No return value."), onVoid);
	// Description without a type, and from the comment above the function.
	assert(hover(src("").replace("function plain(): bool", "function plain(): bo|ol")).includes("**@return** Whether it worked"));
	assert(hover(src("").replace("function named(): string", "function named(): str|ing")).includes("**@return** The name"));
	// Nothing written, nothing added.
	const bare = hover(src("").replace("function bare(): int", "function bare(): i|nt"));
	assert(bare.includes("(type) int") && !bare.includes("@return"), bare);
	// A class as return type: the class and then the comment.
	const box = hover(src("").replace("function make(): Box", "function make(): B|ox"));
	assert(box.includes("class Box") && box.includes("**@return** The new box"), box);
	// Comments of a nested function belong to it.
	const nested = hover(src("").replace("function nested(): int", "function nested(): i|nt"));
	assert(!nested.includes("Inner only"), nested);
	// Parameters are not return types.
	assert(!hover(src("").replace("function plain(): bool", "function plain(a: in|t): bool")).includes("Whether it worked"));

	// The function itself: the body's @return becomes part of its documentation.
	const fn = hover(src("").replace("function remove_all_vehicles()", "function remove_all_veh|icles()"));
	assert(fn.includes("Removes every vehicle.") && fn.includes("@return void Nothing; vehicles are deleted one by one"), fn);
	assert.strictEqual(fn.split("@return void Nothing").length, 2, "not duplicated");
	const named = hover(src("").replace("function named()", "function na|med()"));
	assert.strictEqual(named.split("@return string The name").length, 2, "a comment above is not added twice");

	// Signature help shows it too.
	const sig = signature(src("remove_all_vehicles(|"));
	assert(sig.signatures[0].documentation.value.includes("Removes every vehicle.") && sig.signatures[0].documentation.value.includes("@return void Nothing"), JSON.stringify(sig.signatures[0].documentation));
});

// ---------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------

const { lintSource, lintManifest } = require("../src/lint");
const compiler = require("../src/compiler");

function lint(text, options)
{
	const record = index.setFile(vscode.Uri.file("/ws/lintme.pluto").toString(), "/ws/lintme.pluto", text);
	try
	{
		return lintSource(text, record, analyzer, options);
	}
	finally
	{
		index.removeFile(vscode.Uri.file("/ws/lintme.pluto").toString());
	}
}

test("lint: broken require paths", function ()
{
	const problems = lint([
		"local util = require(\"lib.util\")",
		"local chat = require \"chat-module\"",
		"local json = require(\"pluto:json\")",
		"local crypto = require \"crypto\"",
		"local nope = require(\"lib/missing\")",
		"local disk = require(\"ondisk\")",
	].join("\n"), { exists: p => p == "/ws/ondisk.lua", searchDirs: [] });
	assert.deepStrictEqual(problems.map(p => [p.code, p.line, p.col, p.endCol]), [["missing-module", 4, 21, 34]]);
	assert.strictEqual(problems[0].severity, "warning");
	assert(problems[0].message.includes("lib/missing"));
});

test("lint: calls with too few arguments", function ()
{
	const problems = lint([
		"greet()",                                  // 0: who missing
		"greet(\"bob\")",                           // 1: ok, loud is optional
		"local h = new Human()",                    // 2: name missing
		"local h2 = new Human(\"x\")",              // 3: ok, age has a default
		"Human.create()",                           // 4: name missing
		"local u = require(\"lib.util\")",
		"u.add(1)",                                 // 6: b missing
		"u:method()",                               // 7: x missing
		"u.method(u, 1)",                           // 8: ok
		"greet(...)",                               // 9: unknown count
		"greet(get())",                             // 10: unknown count
		"local function f(a, b) end",
		"f(1)",                                     // 12: b missing
		"local g = 5",
		"unknownThing.call()",                      // 14: unknown callee
		"function greet2(a) end",                   // 15: declaration
		"local x = { greet() }",                    // 16: who missing
		"greet((get()))",                           // 17: ok, exactly one value
	].join("\n"));
	assert.deepStrictEqual(problems.map(p => p.line), [0, 2, 4, 6, 7, 12, 16]);
	assert(problems.every(p => p.code == "missing-arguments" && p.severity == "warning"));
	assert(/'greet' expects at least 1 argument but got 0\. Required: who\./.test(problems[0].message), problems[0].message);
	assert(problems[1].message.includes("new Human"), problems[1].message);
	assert.strictEqual(problems[1].col, 10);
});

test("lint: info.json manifests", function ()
{
	const exists = p => p == "/ws/mods/new/main.pluto";
	const ok = lintManifest(JSON.stringify({ id: "new", entry: "main.pluto", dependencies: ["chat-module"] }, null, "\t"), "/ws/mods/new/info.json", index, { exists });
	assert.deepStrictEqual(ok, []);
	const text = "{\n\t\"entry\": \"start.pluto\",\n\t\"dependencies\": [\"chat-module\", \"ghost\"]\n}";
	const bad = lintManifest(text, "/ws/mods/new/info.json", index, { exists });
	assert.deepStrictEqual(bad.map(p => [p.code, p.severity, p.line]), [
		["manifest-id", "error", 0],
		["manifest-entry", "error", 1],
		["manifest-dependency", "warning", 2],
	]);
	assert.deepStrictEqual([bad[2].col, bad[2].endCol], [33, 40]);
	// An unrelated info.json is left alone.
	assert.deepStrictEqual(lintManifest("{\"name\": \"x\"}", "/elsewhere/info.json", index, {}), []);
	// The entry file can also be an indexed file.
	assert.deepStrictEqual(lintManifest("{\"id\": \"c\", \"entry\": \"init.pluto\"}", "/ws/mods/chat/info.json", index, {}), []);
});

test("compiler: output parsing", function ()
{
	const lines = ["local x = 1", "if x then", "  print(x y)", "end"];
	const out = compiler.parseCompilerOutput([
		"C:\\tools\\plutoc.exe: stdin:3: ')' expected near 'y'",
		"stdin:1: warning: unused local 'x' [unused]",
		"    1 | local x = 1",
		"      |       ^ here: declared here",
		"\x1b[31mstdin:4: syntax error: unexpected 'end'\x1b[0m",
	].join("\r\n"), lines);
	assert.deepStrictEqual(out.map(p => [p.line, p.severity, p.col, p.endCol]), [
		[2, "error", 10, 11],
		[0, "warning", 6, 7],
		[3, "error", null, null],
	]);
	assert.strictEqual(out[0].message, "')' expected near 'y'");
	assert(out[1].message.startsWith("unused local 'x' [unused]"), out[1].message);
	assert.strictEqual(out[2].message, "syntax error: unexpected 'end'");
	assert.deepStrictEqual(compiler.parseCompilerOutput("", lines), []);

	// Real Pluto 0.13 output: excerpts are printed without indentation, warnings have a prefix.
	const src = ["local function f()", "  local a = 1", "  local a = 2", "  print(a b)", "end"];
	const real = compiler.parseCompilerOutput([
		"Pluto warning: stdin:3: duplicate local declaration [var-shadow]",
		"    3 | local a = 2",
		"      | ^^^^^^^^^^^ here: this shadows the initial declaration of 'a' on line 2.",
		"C:\\Program Files\\pluto\\plutoc.exe: stdin:4: ')' expected near 'b'",
		"    4 | print(a b)",
		"      |         ^ here: this is invalid syntax.",
	].join("\n"), src);
	assert.deepStrictEqual(real.map(p => [p.line, p.severity, p.col, p.endCol]), [[2, "warning", 2, 13], [3, "error", 10, 11]]);
	assert.strictEqual(real[0].message, "duplicate local declaration [var-shadow] (this shadows the initial declaration of 'a' on line 2.)");
});

testAsync("compiler: a real plutoc checks stdin without running it (skipped when not installed)", async function ()
{
	const found = compiler.findOnPath();
	if (!found)
	{
		return;
	}
	const bad = await compiler.runCheck(found, "os.exit(3)\nlocal x = (\n").promise;
	const problems = compiler.parseCompilerOutput(bad.output, ["os.exit(3)", "local x = ("]);
	assert.notStrictEqual(bad.code, 3, "the code must not run");
	assert.strictEqual(problems.length, 1, bad.output);
	assert.strictEqual(problems[0].severity, "error");
	const good = await compiler.runCheck(found, "os.exit(3)\n").promise;
	assert.strictEqual(good.code, 0, good.output);
	assert.deepStrictEqual(compiler.parseCompilerOutput(good.output, []), []);
});

test("compiler: discovery prefers settings, then the newest local compiler, then PATH", function ()
{
	const os = require("os");
	const exe = process.platform == "win32" ? ".exe" : "";
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pluto-ws-"));
	const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pluto-path-"));
	const touch = function (p)
	{
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, "");
		fs.chmodSync(p, 0o755);
		return p;
	};
	try
	{
		assert.deepStrictEqual(compiler.findCompiler({ workspaceFolders: [root], envPath: "" }), { path: null, source: null, problem: undefined });
		const onPath = touch(path.join(bin, "pluto" + exe));
		assert.deepStrictEqual(compiler.findCompiler({ workspaceFolders: [root], envPath: bin }), { path: onPath, source: "path", problem: undefined });
		touch(path.join(root, "pluto", "0.9.4", "plutoc" + exe));
		const newest = touch(path.join(root, "pluto", "0.10.1", "plutoc" + exe));
		touch(path.join(root, "pluto", "0.10.1", "pluto" + exe));
		touch(path.join(root, "src", "pluto" + exe)); // not a known folder
		assert.strictEqual(compiler.findCompiler({ workspaceFolders: [root], envPath: bin }).path, newest);
		const custom = touch(path.join(root, "custom", "my-pluto" + exe));
		const fromSetting = compiler.findCompiler({ configured: "${workspaceFolder}/custom/my-pluto" + exe, workspaceFolders: [root], envPath: bin });
		assert.deepStrictEqual([fromSetting.path, fromSetting.source], [custom, "setting"]);
		const broken = compiler.findCompiler({ configured: "${workspaceFolder}/nope" + exe, workspaceFolders: [root], envPath: bin });
		assert.deepStrictEqual([broken.path, broken.source], [newest, "workspace"]);
		assert(broken.problem.includes("not an executable"));
		assert.strictEqual(compiler.findCompiler({ workspaceFolders: [root], envPath: bin, allowWorkspace: false }).path, onPath);
		assert.deepStrictEqual(compiler.checkArgs(newest), ["-p", "-"]);
		assert.strictEqual(compiler.checkArgs(onPath)[0], "-e");
	}
	finally
	{
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(bin, { recursive: true, force: true });
	}
});

function testAsync(name, fn)
{
	asyncTests.push({ name, fn });
}

testAsync("plua.lua.enable: Lua support follows the setting without a reload", async function ()
{
	const { LanguageService, registerLanguageProviders, selectorFor } = require("../src/extension");
	const { DiagnosticsManager } = require("../src/diagnostics");
	createFakeWorkspace({
		"/ws/a.pluto": "local m = require(\"mod\")\n",
		"/ws/mod.lua": "local M = {}\nfunction M.hello_lua(who) end\nreturn M\n",
	});
	const svc = new LanguageService();
	const lp = createProviders(svc);
	const hasLua = (selector) => selector.some(s => s.language == "lua") && selector.some(s => s.pattern == "**/*.lua");

	// Fake language/diagnostic APIs.
	const kinds = ["CompletionItem", "Hover", "SignatureHelp", "Definition", "DocumentSymbol", "FoldingRange"];
	const registrations = [];
	vscode.languages = {};
	for (const kind of kinds)
	{
		vscode.languages["register" + kind + "Provider"] = function (selector)
		{
			const entry = { kind, selector, disposed: false };
			registrations.push(entry);
			return { dispose() { entry.disposed = true; } };
		};
	}
	const store = new Map();
	vscode.languages.createDiagnosticCollection = () => ({ set: (u, d) => store.set(u.toString(), d), delete: u => store.delete(u.toString()), dispose() {} });
	vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };
	vscode.DiagnosticSeverity = { Error: 0, Warning: 1 };
	vscode.window.createOutputChannel = () => ({ appendLine() {}, dispose() {} });
	const luaDoc = vscode.createDocument("/ws/b.lua", "local x = require(\"nothing_here\")\n", "lua");
	const plutoDoc = vscode.createDocument("/ws/c.pluto", "local x = require(\"nothing_here\")\n", "pluto");
	const manager = new DiagnosticsManager(svc);
	manager._compiler_ = { path: null, source: null }; // built-in checks only
	const diagnosticsOf = (doc) => (store.get(doc.uri.toString()) || []).map(d => d.code);
	try
	{
		// Defaults: everything on for both languages.
		assert.strictEqual(svc.luaEnabled(), true);
		assert.strictEqual(svc.handles(luaDoc), true);
		assert.strictEqual(svc.handles(plutoDoc), true);
		const controller = registerLanguageProviders({ subscriptions: [] }, svc, lp);
		assert.strictEqual(registrations.length, 6);
		assert(registrations.every(r => hasLua(r.selector)));
		assert.deepStrictEqual(registrations.map(r => r.kind), kinds);
		vscode.workspace.textDocuments.push(luaDoc, plutoDoc);
		await manager.check(luaDoc);
		await manager.check(plutoDoc);
		assert.deepStrictEqual(diagnosticsOf(luaDoc), ["missing-module"]);
		assert.deepStrictEqual(diagnosticsOf(plutoDoc), ["missing-module"]);
		await svc.scan();
		assert.deepStrictEqual(lp.workspaceSymbolProvider.provideWorkspaceSymbols("hello_lua").map(s => s.args[0]), ["M.hello_lua"]);

		// Off: providers are re-registered for Pluto only, Lua diagnostics disappear, Pluto's stay.
		vscode.config["plua.lua.enable"] = false;
		assert.strictEqual(svc.handles(luaDoc), false);
		assert.strictEqual(svc.handles(plutoDoc), true);
		controller.refresh();
		assert.strictEqual(registrations.length, 12);
		assert(registrations.slice(0, 6).every(r => r.disposed));
		assert(registrations.slice(6).every(r => !r.disposed && !hasLua(r.selector) && r.selector[0].language == "pluto"));
		assert.deepStrictEqual(controller.selector, selectorFor(false));
		controller.refresh();
		assert.strictEqual(registrations.length, 12, "nothing changes when the setting did not");
		manager.recheckAll(true);
		assert.deepStrictEqual(diagnosticsOf(luaDoc), []);
		assert.deepStrictEqual(diagnosticsOf(plutoDoc), ["missing-module"]);
		manager.schedule(luaDoc, true);
		await new Promise(r => setTimeout(r, 20));
		assert.deepStrictEqual(diagnosticsOf(luaDoc), [], "edits of Lua files are ignored");
		// Lua files are still read for Pluto code (plua.lua.indexFiles), but offer no features of their own.
		await svc.scan();
		assert(svc.index.lookup("hello_lua").length == 1);
		assert.deepStrictEqual(lp.workspaceSymbolProvider.provideWorkspaceSymbols("hello_lua"), []);

		// On again.
		delete vscode.config["plua.lua.enable"];
		controller.refresh();
		assert.strictEqual(registrations.length, 18);
		assert(registrations.slice(12).every(r => hasLua(r.selector)));
		manager.recheckAll(false);
		assert.deepStrictEqual(diagnosticsOf(luaDoc), ["missing-module"]);

		// Indexing is separate: Lua files can be kept out of the index while the features stay on.
		vscode.config["plua.lua.indexFiles"] = false;
		await svc.scan();
		assert.strictEqual(svc.index.lookup("hello_lua").length, 0);
		const record = svc.getRecord(luaDoc);
		assert.strictEqual(record.excluded, true, "an open Lua file works on its own");
		assert(!svc.index.files.has(luaDoc.uri.toString()));
		delete vscode.config["plua.lua.indexFiles"];
		// The older setting still switches Lua indexing off.
		vscode.config["plua.index.includeLua"] = false;
		await svc.scan();
		assert.strictEqual(svc.index.lookup("hello_lua").length, 0);
		delete vscode.config["plua.index.includeLua"];
		await svc.scan();
		assert.strictEqual(svc.index.lookup("hello_lua").length, 1);
		controller.dispose();
	}
	finally
	{
		manager.dispose();
		svc.dispose();
		delete vscode.languages;
		delete vscode.Diagnostic;
		delete vscode.DiagnosticSeverity;
		delete vscode.window.createOutputChannel;
		for (const key of Object.keys(vscode.config))
		{
			delete vscode.config[key];
		}
	}
});

testAsync("service: ignore files and settings control what is indexed", async function ()
{
	const { LanguageService } = require("../src/extension");
	const { disk } = createFakeWorkspace({
		"/ws/.gitignore": "build/\n*.generated.pluto\n",
		"/ws/.plutoignore": "legacy/**\n",
		"/ws/src/main.pluto": "function mainFn() end\n",
		"/ws/build/out.pluto": "function buildFn() end\n",
		"/ws/src/api.generated.pluto": "function generatedFn() end\n",
		"/ws/legacy/old.lua": "function legacyFn() end\n",
		"/ws/vendor/dep.pluto": "function vendorFn() end\n",
		"/ws/vendor/info.json": "{ \"id\": \"vendor-dep\" }",
		"/ws/node_modules/x.pluto": "function nodeFn() end\n",
	});
	const names = (svc) => [...svc.index.files.values()].flatMap(f => f.symbols.filter(s => !s.container).map(s => s.name)).sort();
	const service = new LanguageService();
	try
	{
		await service.scan();
		assert.deepStrictEqual(names(service), ["mainFn", "vendorFn"]);
		assert.strictEqual(service.excludedCount, 4);
		assert.deepStrictEqual([...service.index.manifests.values()].map(m => m.id), ["vendor-dep"]);

		// plua.workspace.exclude, applied incrementally.
		vscode.config["plua.workspace.exclude"] = ["**/vendor/**"];
		await service.scan({ incremental: true });
		assert.deepStrictEqual(names(service), ["mainFn"]);
		assert.strictEqual(service.index.manifests.size, 0, "manifests in excluded folders are dropped too");

		// Editing an ignore file: the file it now covers is removed from the index.
		disk.set("/ws/.plutoignore", "legacy/**\nsrc/main.pluto\n");
		await service.scan({ incremental: true });
		assert.deepStrictEqual(names(service), []);

		// plua.workspace.ignoreFiles without .plutoignore, and useGitignore off.
		vscode.config["plua.workspace.ignoreFiles"] = [".gitignore"];
		vscode.config["plua.workspace.useGitignore"] = false;
		await service.scan({ incremental: true });
		assert.deepStrictEqual(names(service), ["buildFn", "generatedFn", "legacyFn", "mainFn"]);

		// search.exclude, and plua.workspace.useSearchExclude.
		vscode.config["search.exclude"] = { "**/build": true, "**/legacy/**": false };
		await service.scan({ incremental: true });
		assert.deepStrictEqual(names(service), ["generatedFn", "legacyFn", "mainFn"]);
		vscode.config["plua.workspace.useSearchExclude"] = false;
		await service.scan({ incremental: true });
		assert.deepStrictEqual(names(service), ["buildFn", "generatedFn", "legacyFn", "mainFn"]);

		// files.exclude always applies; the legacy plua.index.exclude setting still works.
		vscode.config["files.exclude"] = { "legacy": true };
		vscode.config["plua.index.exclude"] = ["build/**"];
		await service.scan({ incremental: true });
		assert.deepStrictEqual(names(service), ["generatedFn", "mainFn"]);

		// A file created in an excluded folder is not picked up by the file watcher.
		disk.set("/ws/build/new.pluto", "function newBuildFn() end\n");
		await service.indexUri(vscode.Uri.file("/ws/build/new.pluto"));
		assert(!names(service).includes("newBuildFn"));

		// An excluded file that is open is analyzed on its own, without joining the index.
		const doc = vscode.createDocument("/ws/build/out.pluto", disk.get("/ws/build/out.pluto"));
		const record = service.getRecord(doc);
		assert.strictEqual(record.excluded, true);
		assert(!service.index.files.has(doc.uri.toString()));
		assert.strictEqual(service.index.lookup("buildFn").length, 1, "visible from the file itself");
		service.getRecord(vscode.createDocument("/ws/src/main.pluto", disk.get("/ws/src/main.pluto")));
		assert.strictEqual(service.index.lookup("buildFn").length, 0, "invisible from other files");
	}
	finally
	{
		service.dispose();
		for (const key of Object.keys(vscode.config))
		{
			delete vscode.config[key];
		}
	}
});

(async function ()
{
	for (const { name, fn } of asyncTests)
	{
		try
		{
			await fn();
			++passed;
		}
		catch (e)
		{
			++failed;
			console.log("FAIL: " + name + "\n" + (e.stack || e));
		}
	}
	console.log(passed + " passed, " + failed + " failed");
	if (failed)
	{
		process.exit(1);
	}
})();

test("union types: hover on the | of a type hint", function ()
{
	const { unionAt, describeUnion } = require("../src/typeHints");
	const line = "function f(value: int|string) end";
	const u = unionAt(line, line.indexOf("|"));
	assert.deepStrictEqual(u.members.map(m => m.text), ["int", "string"]);
	assert.strictEqual(line.slice(u.start, u.end), "int|string");
	const d = describeUnion(u);
	assert.strictEqual(d.title, "(union type) int | string");
	assert(d.text.includes("- `int`") && d.text.includes("- `string`") && !d.text.includes("nil"), d.text);
	// `?` adds nil, whichever side it is written on.
	const q = "function f(v: ?int | string?) end";
	const dq = describeUnion(unionAt(q, q.indexOf("|")));
	assert.strictEqual(dq.title, "(union type that allows nil) ?int | string?");
	assert(dq.text.includes("- `nil`"), dq.text);
	// An explicit nil is the same as `?`.
	const n = "local x: int|nil = 1";
	const dn = describeUnion(unionAt(n, n.indexOf("|")));
	assert(dn.text.includes("- `nil`") && dn.text.includes("Same as `int?`"), dn.text);
	// Three members; any `|` of the union works.
	const three = "function f(a: int|string|bool) end";
	assert.strictEqual(unionAt(three, three.lastIndexOf("|")).members.length, 3);
	// Not type hints: lambda, bitwise or.
	assert.strictEqual(unionAt("local f = |a, b| a + b", 15), null);
	assert.strictEqual(unionAt("local x = a|b", 11), null);
	// The provider returns it with the range of the whole union; the russian text is localized.
	const doc = vscode.createDocument("/ws/main.pluto", line);
	const h = providers.hoverProvider.provideHover(doc, new vscode.Position(0, line.indexOf("|")));
	assert(h.contents[0].value.includes("(union type) int | string"), h.contents[0].value);
	assert.strictEqual(h.range.start.character, u.start);
	assert.strictEqual(h.range.end.character, u.end);
	const i18n = require("../src/i18n");
	i18n.setLanguage("ru");
	try
	{
		assert.strictEqual(describeUnion(u).title, "(объединение типов) int | string");
		assert.strictEqual(describeUnion(unionAt(n, n.indexOf("|"))).title, "(объединение, допускающее nil) int | nil");
		assert(require("../src/typeHints").describeNullable("int?").title.startsWith("(допускающий nil)"));
	}
	finally
	{
		i18n.setLanguage("en");
	}
});

test("highlight colors: styles are parsed and the rules of the user are kept", function ()
{
	const { parseStyle, buildRules, mergeRules, RULE_PREFIX } = require("../src/highlightColors");
	assert.deepStrictEqual(parseStyle("#FFAA00"), { foreground: "#FFAA00" });
	assert.deepStrictEqual(parseStyle("#fa0 bold italic"), { foreground: "#fa0", fontStyle: "bold italic" });
	assert.deepStrictEqual(parseStyle("bold"), { fontStyle: "bold" });
	assert.deepStrictEqual(parseStyle("#fff normal"), { foreground: "#fff", fontStyle: "" });
	// Typos and other values give nothing instead of a wrong color.
	for (const bad of ["red", "#12", "#ggg", "#fff bolt", "", 5, null, undefined, {}])
	{
		assert.strictEqual(parseStyle(bad), null, String(bad));
	}
	assert.deepStrictEqual(buildRules(undefined, undefined), []);
	assert.deepStrictEqual(buildRules({}, []), []);
	const rules = buildRules({ functionName: "#111111", parameter: "oops", unknownKey: "#222222" }, ["#333333", "bad", "#444444"]);
	assert.strictEqual(rules.filter(r => r.name == RULE_PREFIX + "functionName").length, 1);
	assert(!rules.some(r => r.name == RULE_PREFIX + "parameter"), "an invalid style is skipped");
	assert(!rules.some(r => r.name.includes("unknownKey")));
	const braces = rules.filter(r => r.name.startsWith(RULE_PREFIX + "tableBracket "));
	assert.strictEqual(braces.length, 8);
	assert.strictEqual(braces[0].settings.foreground, "#333333");
	assert.strictEqual(braces[1].settings.foreground, "#444444");
	assert.strictEqual(braces[2].settings.foreground, "#333333", "the palette repeats");
	assert.deepStrictEqual(braces[1].scope, ["meta.table.pluto meta.table.pluto punctuation.section.table.begin.pluto", "meta.table.pluto meta.table.pluto punctuation.section.table.end.pluto"]);
	// Merging: own rules stay, old managed rules are replaced, and nothing is left when turned off.
	const own = [{ scope: "comment", settings: { foreground: "#00ff00" } }, { name: "mine", scope: "string", settings: { foreground: "#ff0000" } }];
	const merged = mergeRules(own.concat([{ name: RULE_PREFIX + "old", scope: "x", settings: {} }]), rules);
	assert.deepStrictEqual(merged.slice(0, 2), own);
	assert(!merged.some(r => r.name == RULE_PREFIX + "old"));
	assert.strictEqual(merged.length, 2 + rules.length);
	assert.deepStrictEqual(mergeRules(merged, []), own);
	assert.deepStrictEqual(mergeRules(undefined, []), []);
});

test("highlight colors: the object form { color, fontStyle } and the return type category", function ()
{
	const { parseStyle, buildRules, CATEGORIES } = require("../src/highlightColors");
	assert.deepStrictEqual(parseStyle({ color: "#FF8800", fontStyle: "bold italic" }), { foreground: "#FF8800", fontStyle: "bold italic" });
	assert.deepStrictEqual(parseStyle({ color: "#FF8800" }), { foreground: "#FF8800" });
	assert.deepStrictEqual(parseStyle({ fontStyle: "bold" }), { fontStyle: "bold" });
	assert.strictEqual(parseStyle({}), null);
	assert.strictEqual(parseStyle({ color: "orange" }), null);
	assert.strictEqual(parseStyle([]), null);
	// A table bracket palette accepts both forms.
	const rules = buildRules({ returnType: { color: "#112233", fontStyle: "bold" } }, [{ color: "#445566" }, "#778899 italic"]);
	const ret = rules.find(r => r.name == "Pluto: returnType");
	assert.deepStrictEqual(ret.scope, ["meta.return-type.pluto storage.type.primitive.pluto"]);
	assert.strictEqual(rules.find(r => r.name == "Pluto: tableBracket 1").settings.foreground, "#445566");
	assert.strictEqual(rules.find(r => r.name == "Pluto: tableBracket 2").settings.fontStyle, "italic");
	// Every category of the code is in the settings schema, with a text in both languages.
	const pkg = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "package.json"), "utf8"));
	const schema = pkg.contributes.configuration.properties["plua.highlight.colors"].properties;
	assert.deepStrictEqual(Object.keys(schema).sort(), Object.keys(CATEGORIES).sort());
	for (const prop of Object.values(schema))
	{
		assert.strictEqual(prop.properties.color.format, "color-hex", "the color gets a picker");
	}
});

test("highlight colors: wrong values are reported and never applied", function ()
{
	const { checkStyle, isInvisibleColor, findProblems, buildRules } = require("../src/highlightColors");
	// Fully transparent colors would make the text invisible.
	for (const color of ["#0000", "#00000000", "#ABC0", "#ff880000"])
	{
		assert(isInvisibleColor(color), color);
		assert.strictEqual(checkStyle(color).problem, "transparent", color);
		assert.strictEqual(checkStyle(color).settings, null);
		assert.strictEqual(checkStyle({ color, fontStyle: "bold" }).problem, "transparent");
	}
	for (const color of ["#000", "#000F", "#00000001", "#ff8800", "#00f7ff7a", "#ffff"])
	{
		assert(!isInvisibleColor(color), color);
		assert.strictEqual(checkStyle(color).problem, undefined, color);
	}
	// Typos and wrong types are reported, an empty value is simply "not set".
	assert.strictEqual(checkStyle("orange").problem, "invalid");
	assert.strictEqual(checkStyle("#12").problem, "invalid");
	assert.strictEqual(checkStyle("#fff bolt").problem, "invalid");
	assert.strictEqual(checkStyle(5).problem, "invalid");
	assert.strictEqual(checkStyle(true).problem, "invalid");
	assert.deepStrictEqual(checkStyle(""), { settings: null });
	assert.deepStrictEqual(checkStyle(undefined), { settings: null });
	assert.deepStrictEqual(checkStyle({}), { settings: null });
	assert.deepStrictEqual(checkStyle("#fff bold"), { settings: { foreground: "#fff", fontStyle: "bold" } });
	// The list of problems of the settings.
	assert.deepStrictEqual(findProblems(undefined, undefined), []);
	assert.deepStrictEqual(findProblems({ functionName: "", type: "#112233" }, []), []);
	const problems = findProblems(
		{ functionName: "#0000", parameter: "blue", functonKeyword: "#112233", type: "#112233", returnType: { color: "#00000000" } },
		["#445566", "nope", "#0000"]);
	assert.deepStrictEqual(problems.map(p => [p.name, p.problem]), [
		["colors.functionName", "transparent"],
		["colors.parameter", "invalid"],
		["functonKeyword", "unknownKey"],
		["colors.returnType", "transparent"],
		["tableBracketColors[1]", "invalid"],
		["tableBracketColors[2]", "transparent"],
	]);
	// Nothing wrong is turned into a rule: the color of the theme stays.
	const rules = buildRules({ functionName: "#0000", parameter: "blue", type: "#112233" }, ["#0000"]);
	assert.deepStrictEqual(rules.map(r => r.name), ["Pluto: type"]);
});

test("highlight colors: darkColor and lightColor of the object form follow the kind of the theme", function ()
{
	const { checkStyle, parseStyle, findProblems, buildRules } = require("../src/highlightColors");
	const both = { color: "#111111", darkColor: "#222222", lightColor: "#333333", fontStyle: "bold" };
	assert.deepStrictEqual(parseStyle(both, "dark"), { foreground: "#222222", fontStyle: "bold" });
	assert.deepStrictEqual(parseStyle(both, "light"), { foreground: "#333333", fontStyle: "bold" });
	assert.deepStrictEqual(parseStyle(both), { foreground: "#222222", fontStyle: "bold" }, "dark is the default");
	// What is not set falls back to `color`; `color` alone is for every theme.
	assert.deepStrictEqual(parseStyle({ color: "#111111", lightColor: "#333333" }, "dark"), { foreground: "#111111" });
	assert.deepStrictEqual(parseStyle({ color: "#111111", lightColor: "#333333" }, "light"), { foreground: "#333333" });
	assert.deepStrictEqual(parseStyle({ color: "#111111" }, "light"), { foreground: "#111111" });
	assert.deepStrictEqual(parseStyle({ lightColor: "#333333" }, "light"), { foreground: "#333333" });
	assert.strictEqual(parseStyle({ lightColor: "#333333" }, "dark"), null, "nothing for dark themes: the theme color stays");
	assert.deepStrictEqual(parseStyle({ color: "#111111 italic" }, "dark"), { foreground: "#111111", fontStyle: "italic" });
	// A wrong color in any of the fields is reported, whichever theme is active.
	for (const kind of ["dark", "light"])
	{
		assert.strictEqual(checkStyle({ color: "#111111", lightColor: "#0000" }, kind).problem, "transparent", kind);
		assert.strictEqual(checkStyle({ color: "#111111", darkColor: "blue" }, kind).problem, "invalid", kind);
		assert.strictEqual(checkStyle({ lightColor: 5 }, kind).problem, "invalid", kind);
	}
	assert.deepStrictEqual(findProblems({ type: { color: "#111111", lightColor: "#0000" } }, []).map(p => [p.name, p.problem]), [["colors.type", "transparent"]]);
	// Rules, including the palette of table braces.
	const colors = { functionName: both, type: { color: "#444444" } };
	const brackets = [{ darkColor: "#aa0000", lightColor: "#00aa00" }, "#0000ff"];
	const dark = buildRules(colors, brackets, "dark");
	const light = buildRules(colors, brackets, "light");
	assert.strictEqual(dark.find(r => r.name == "Pluto: functionName").settings.foreground, "#222222");
	assert.strictEqual(light.find(r => r.name == "Pluto: functionName").settings.foreground, "#333333");
	assert.strictEqual(light.find(r => r.name == "Pluto: type").settings.foreground, "#444444");
	assert.strictEqual(dark.find(r => r.name == "Pluto: tableBracket 1").settings.foreground, "#aa0000");
	assert.strictEqual(light.find(r => r.name == "Pluto: tableBracket 1").settings.foreground, "#00aa00");
	assert.strictEqual(light.find(r => r.name == "Pluto: tableBracket 2").settings.foreground, "#0000ff");
	// Every color field of the schema has a picker.
	const pkg = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "package.json"), "utf8"));
	for (const prop of Object.values(pkg.contributes.configuration.properties["plua.highlight.colors"].properties))
	{
		for (const field of ["color", "darkColor", "lightColor"])
		{
			assert.strictEqual(prop.properties[field].format, "color-hex", field);
		}
	}
});

test("compiler: a Lua interpreter is found in bin/lua of the workspace, else on the PATH", function ()
{
	const os = require("os");
	const exe = process.platform == "win32" ? ".exe" : "";
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lua-ws-"));
	const bin = fs.mkdtempSync(path.join(os.tmpdir(), "lua-path-"));
	const touch = function (p)
	{
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, "");
		fs.chmodSync(p, 0o755);
		return p;
	};
	try
	{
		for (const name of ["lua", "luac", "lua54", "lua5.4", "luac5.4", "luajit", "lua-5.4"])
		{
			assert(compiler.isLuaName(name + exe), name + exe);
		}
		for (const name of ["pluto", "plutoc", "lua.dll", "luarocks", "lualib", "script.lua", "lua.h", "alua"])
		{
			assert(!compiler.isLuaName(name + (exe && !/\./.test(name) ? exe : "")), name);
		}
		const lua = { workspaceFolders: [root], envPath: "", family: "lua" };
		assert.deepStrictEqual(compiler.findCompiler(lua), { path: null, source: null, problem: undefined });
		// A Pluto compiler is never taken for a Lua interpreter, and the other way round.
		touch(path.join(root, "bin", "pluto", "plutoc" + exe));
		assert.strictEqual(compiler.findCompiler(lua).path, null);
		assert.strictEqual(compiler.findCompiler({ workspaceFolders: [root], envPath: "" }).path.includes("plutoc"), true);
		// bin/lua: luac (parse-only) is preferred over lua; the newest version wins.
		touch(path.join(root, "bin", "lua", "lua" + exe));
		const luac = touch(path.join(root, "bin", "lua", "luac" + exe));
		const found = compiler.findCompiler(lua);
		assert.deepStrictEqual([found.path, found.source], [luac, "workspace"]);
		touch(path.join(root, "tools", "lua5.1", "luac" + exe));
		const newer = touch(path.join(root, "tools", "lua5.4", "luac" + exe));
		assert.strictEqual(compiler.findCompiler(lua).path, newer);
		touch(path.join(root, "src", "luac" + exe)); // not a known folder
		// Only `lua` in the folder: used with a script that only compiles.
		const only = fs.mkdtempSync(path.join(os.tmpdir(), "lua-only-"));
		try
		{
			const interpreter = touch(path.join(only, "bin", "lua", "lua" + exe));
			assert.strictEqual(compiler.findCompiler({ workspaceFolders: [only], envPath: "", family: "lua" }).path, interpreter);
			assert.strictEqual(compiler.checkArgs(interpreter)[0], "-e");
			assert(compiler.checkArgs(interpreter)[1].includes("loadstring or load"));
		}
		finally
		{
			fs.rmSync(only, { recursive: true, force: true });
		}
		assert.deepStrictEqual(compiler.checkArgs(luac), ["-p", "-"]);
		// The PATH is the last resort; a configured path comes first.
		const onPath = touch(path.join(bin, "luac" + exe));
		assert.deepStrictEqual(compiler.findCompiler({ workspaceFolders: [root], envPath: bin, family: "lua", allowWorkspace: false }), { path: onPath, source: "path", problem: undefined });
		const custom = touch(path.join(root, "custom", "my-lua" + exe));
		const fromSetting = compiler.findCompiler({ configured: "${workspaceFolder}/custom/my-lua" + exe, workspaceFolders: [root], envPath: bin, family: "lua" });
		assert.deepStrictEqual([fromSetting.path, fromSetting.source], [custom, "setting"]);
	}
	finally
	{
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(bin, { recursive: true, force: true });
	}
});

testAsync("compiler: a real Lua interpreter checks .lua code without running it (skipped when not installed)", async function ()
{
	const found = compiler.findOnPath(undefined, "lua");
	if (!found)
	{
		return;
	}
	const bad = await compiler.runCheck(found, "os.exit(3)\nlocal x = (\n").promise;
	const problems = compiler.parseCompilerOutput(bad.output, ["os.exit(3)", "local x = ("]);
	assert.notStrictEqual(bad.code, 3, "the code must not run");
	assert.strictEqual(problems.length, 1, bad.output);
	assert.strictEqual(problems[0].severity, "error");
	assert(problems[0].line >= 1, "the error is after the first line (Lua reports the end of the file)");
	const good = await compiler.runCheck(found, "os.exit(3)\n").promise;
	assert.strictEqual(good.code, 0, good.output);
	assert.deepStrictEqual(compiler.parseCompilerOutput(good.output, []), []);
	// The same with the `lua` interpreter (luac is preferred when both exist): compiled, never run.
	const dir = path.dirname(found);
	const lua = [path.join(dir, "lua" + (process.platform == "win32" ? ".exe" : ""))].find(p => fs.existsSync(p));
	if (lua)
	{
		const viaLua = await compiler.runCheck(lua, "os.exit(3)\nlocal x = (\n").promise;
		assert.notStrictEqual(viaLua.code, 3, "the code must not run: " + viaLua.output);
		const parsed = compiler.parseCompilerOutput(viaLua.output, ["os.exit(3)", "local x = ("]);
		assert.strictEqual(parsed.length, 1, viaLua.output);
		assert(parsed[0].line >= 1);
		assert.strictEqual((await compiler.runCheck(lua, "os.exit(3)\n").promise).code, 0);
	}
});

test("json paths: the strings of a JSON text that look like paths of files", function ()
{
	const { scanStrings, looksLikePath, pathCandidates, suggestionsFor, indexByName } = require("../src/jsonPaths");
	const text = '{\n  // comment "not.lua"\n  "entry": "src/main.pluto",\n  "files": ["a.lua", { "x": "b/c.lua" }],\n  /* "also.lua" */\n  "name": "a \\"quoted\\" lib.lua", "n": 5, "ok": true, "empty": ""\n}';
	const strings = scanStrings(text);
	assert.deepStrictEqual(strings.map(s => [s.value, s.key]), [
		["src/main.pluto", "entry"], ["a.lua", "files"], ["b/c.lua", "x"], ['a "quoted" lib.lua', "name"], ["", "empty"],
	]);
	assert.strictEqual(text.slice(strings[0].start, strings[0].end), '"src/main.pluto"');
	// Keys are never paths, and an unfinished string does not break the scan.
	assert.deepStrictEqual(scanStrings('{ "a.lua": 1, "b": "c.lua"').map(s => s.value), ["c.lua"]);
	assert.deepStrictEqual(scanStrings('{ "b": "unfinished.lua').map(s => s.value), []);
	const ext = new Set([".pluto", ".lua"]);
	for (const yes of ["a.lua", "src/main.pluto", "./x/y.LUA", "..\\up\\z.lua", "C:/dir/f.lua", "dir with space/f.lua"])
	{
		assert(looksLikePath(yes, ext), yes);
	}
	for (const no of ["", "a.txt", "lua", "http://x.com/a.lua", "file:///a.lua", "src/*.lua", "**/*.pluto", "see foo.lua", " a.lua", "a.lua\n", "x/{a,b}.lua", "^a\\.lua$", "dir/.lua.bak", "a/b/"])
	{
		assert(!looksLikePath(no, ext), JSON.stringify(no));
	}
	assert(looksLikePath("img/logo.png", new Set([".png"])));
	// Where a path may point: next to the JSON file and in each workspace folder.
	assert.deepStrictEqual(pathCandidates("src/a.lua", "/ws/mod", ["/ws", "/other"]), ["/ws/mod/src/a.lua", "/ws/src/a.lua", "/other/src/a.lua"]);
	assert.deepStrictEqual(pathCandidates("../a.lua", "/ws/mod", ["/ws"]), ["/ws/a.lua", "/a.lua"]);
	assert.deepStrictEqual(pathCandidates("C:\\x\\a.lua", "/ws", ["/ws"]), ["C:/x/a.lua"]);
	// Moved files, the one with the same ending of the path and the nearest one first.
	const byName = indexByName(["/ws/lib/util.lua", "/ws/mod/helpers/util.lua", "/ws/other/deep/er/util.lua", "/ws/readme.md"]);
	assert.deepStrictEqual(suggestionsFor("util.lua", "/ws/mod", byName), ["helpers/util.lua", "../lib/util.lua", "../other/deep/er/util.lua"]);
	assert.deepStrictEqual(suggestionsFor("old/lib/util.lua", "/ws/mod", byName)[0], "../lib/util.lua");
	assert.deepStrictEqual(suggestionsFor("nothing.lua", "/ws/mod", byName), []);
});

test("json paths: missing files are reported, moved ones with a suggestion", function ()
{
	const { lintJsonPaths } = require("../src/jsonPaths");
	const existing = new Set(["/ws/mod/main.pluto", "/ws/lib/util.lua", "/ws/mod/data"]);
	const ctx = {
		exists: (p) => existing.has(p),
		roots: ["/ws"],
		files: ["/ws/mod/main.pluto", "/ws/lib/util.lua", "/ws/mod/sub/gone.lua"],
		extensions: new Set([".pluto", ".lua"]),
	};
	const text = [
		"{",
		'  "entry": "main.pluto",',                 // 1: next to the JSON file
		'  "util": "lib/util.lua",',                // 2: relative to the workspace folder
		'  "moved": "old/util.lua",',               // 3: not there, but util.lua exists elsewhere
		'  "missing": "nowhere/none.lua",',         // 4
		'  "dir": "data",',                          // 5: no known extension, not checked
		'  "url": "https://example.com/a.lua",',    // 6
		'  "again": "nowhere/none.lua"',            // 7: the same text, reported again
		"}",
	].join("\n");
	const problems = lintJsonPaths(text, "/ws/mod/info.json", ctx);
	assert.deepStrictEqual(problems.map(p => [p.line, p.code, p.severity, p.suggestions]), [
		[3, "json-path", "warning", ["../lib/util.lua"]],
		[4, "json-path", "warning", []],
		[7, "json-path", "warning", []],
	]);
	assert(problems[0].message.includes("old/util.lua") && problems[0].message.includes("Did you mean '../lib/util.lua'?"), problems[0].message);
	assert(problems[1].message.includes("nowhere/none.lua") && problems[1].message.includes("workspace folder"), problems[1].message);
	assert.strictEqual(text.slice(problems[1].start, problems[1].end), '"nowhere/none.lua"');
	assert.deepStrictEqual([problems[1].col, problems[1].endCol], [13, 31]);
	// Properties checked elsewhere are skipped; the severity is a setting.
	const skipped = lintJsonPaths(text, "/ws/mod/info.json", Object.assign({}, ctx, { skipKeys: new Set(["moved", "missing", "again"]), severity: "error" }));
	assert.deepStrictEqual(skipped, []);
	assert.strictEqual(lintJsonPaths(text, "/ws/mod/info.json", Object.assign({}, ctx, { severity: "information" }))[0].severity, "information");
	// Other extensions only when asked for; without a folder nothing else is searched.
	const png = '{ "logo": "img/logo.png", "ok": "main.pluto" }';
	assert.deepStrictEqual(lintJsonPaths(png, "/ws/mod/x.json", ctx), []);
	assert.strictEqual(lintJsonPaths(png, "/ws/mod/x.json", Object.assign({}, ctx, { extensions: new Set([".png", ".pluto"]), files: ["/ws/assets/logo.png"] }))[0].suggestions[0], "../assets/logo.png");
	const noFolder = lintJsonPaths('{ "a": "elsewhere/a.lua" }', "/tmp/x.json", { exists: () => false, roots: [], files: [], extensions: new Set([".lua"]) });
	assert.strictEqual(noFolder.length, 1);
	assert(noFolder[0].message.includes("next to this JSON file") && !noFolder[0].message.includes("workspace"), noFolder[0].message);
	// Russian messages.
	require("../src/i18n").setLanguage("ru");
	try
	{
		assert(lintJsonPaths(text, "/ws/mod/info.json", ctx)[0].message.includes("Возможно, вы имели в виду '../lib/util.lua'"));
	}
	finally
	{
		require("../src/i18n").setLanguage("en");
	}
});

test("workspace filter: .luaignore is an ignore file by default", function ()
{
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	assert.deepStrictEqual(pkg.contributes.configuration.properties["plua.workspace.ignoreFiles"].default, [".gitignore", ".plutoignore", ".luaignore"]);
	const wf = fs.readFileSync(path.join(__dirname, "..", "src", "workspaceFilter.js"), "utf8");
	assert(wf.includes('[".gitignore", ".plutoignore", ".luaignore"]'));
	// All settings of the JSON checks are declared with a default.
	const props = pkg.contributes.configuration.properties;
	assert.deepStrictEqual(props["plua.json.files"].default, ["**/info.json"]);
	assert.deepStrictEqual(props["plua.json.extensions"].default, [".pluto", ".lua"]);
	assert.strictEqual(props["plua.json.checkAllPaths"].default, false);
	assert.strictEqual(props["plua.json.notifyNoFolder"].default, true);
	assert.strictEqual(props["plua.lua.checkSyntax"].default, true);
});

const multiline = require("../src/multilineFormat");
const ML = { params: true, tables: true };

/** Applies a plan to a text, like the editor does, and puts `|` where the cursor goes. */
function applyPlan(text, plan)
{
	assert(plan, "a plan was expected");
	const lines = text.split("\n");
	const offsetOf = (line, col) => lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + col;
	let out = text;
	// Later edits first, so that earlier offsets stay valid.
	for (const e of plan.edits.slice().sort((a, b) => offsetOf(b.line, b.col) - offsetOf(a.line, a.col)))
	{
		out = out.slice(0, offsetOf(e.line, e.col)) + e.text + out.slice(offsetOf(e.endLine, e.endCol));
	}
	const after = out.split("\n");
	after[plan.cursor.line] = after[plan.cursor.line].slice(0, plan.cursor.col) + "|" + after[plan.cursor.line].slice(plan.cursor.col);
	return after.join("\n");
}

/** What typing at the `|` of a text does, with `|` as the cursor. */
function typeFirst(textWithCursor, options)
{
	const offset = textWithCursor.indexOf("|");
	const text = textWithCursor.replace("|", "");
	const before = text.slice(0, offset).split("\n");
	return multiline.planFirstElement(text, before.length - 1, before[before.length - 1].length, options || ML, "    ", "\n");
}

/** What Enter at the `|` does: the text must already contain the new line below the cursor line. */
function enterAt(textWithCursor, options)
{
	const offset = textWithCursor.indexOf("|");
	const text = textWithCursor.replace("|", "");
	const line = text.slice(0, offset).split("\n").length - 1;
	return multiline.planEnter(text, line, options || ML);
}

test("multiline format: the first element typed after ( or { goes to its own line", function ()
{
	const first = (text) => applyPlan(text.replace("|", ""), typeFirst(text));
	assert.strictEqual(first("function name(test: bool = false|\n)\nend"), "function name(\n    test: bool = false|\n)\nend");
	assert.strictEqual(first("local cfg = { enabled = true|\n}"), "local cfg = {\n    enabled = true|\n}");
	// The first typed character is enough, and the rest is typed on the new line afterwards.
	assert.strictEqual(first("function name(t|\n)"), "function name(\n    t|\n)");
	assert.strictEqual(first("local t = {e|\n}"), "local t = {\n    e|\n}");
	// Indentation: one level below the line with the bracket, whatever kind of function it is.
	assert.strictEqual(first("  local function f(a|\n  )"), "  local function f(\n      a|\n  )");
	assert.strictEqual(first("local f = function(a|\n)\nend"), "local f = function(\n    a|\n)\nend");
	assert.strictEqual(first("function obj.sub:method(a|\n)\nend"), "function obj.sub:method(\n    a|\n)\nend");
	assert.strictEqual(first("class A\n  function m(a|\n  )\n  end\nend"), "class A\n  function m(\n      a|\n  )\n  end\nend");
	assert.strictEqual(first("local c = {\n    inner = { a = 1|\n    }\n}"), "local c = {\n    inner = {\n        a = 1|\n    }\n}");
	// What the editor closes on its own stays with the element (quotes), and the cursor keeps its place in it.
	assert.strictEqual(first('local c = { name = "|"\n}'), 'local c = {\n    name = "|"\n}');
	// A tab and CRLF are taken from the caller.
	const tab = multiline.planFirstElement("function f(a\n)", 0, 12, ML, "\t", "\r\n");
	assert.strictEqual(tab.edits[0].text, "\r\n\ta");
	// Not for one-line lists, calls, lambdas, types, or when something is inside already.
	for (const text of [
		"function name(a, b|)", "local t = { 1, 2| }", "function name(a|)\n", "foo(a|\n)",
		"local f = |x| -> int { return x|\n}",
		"function name(a|\n    b\n)", "local t = {\n    a = 1\n    b|\n}", "local t = { a|\n    , b\n}",
		"function name(\n    a|\n)", "local t = {\n    a|\n}", "local t = {  |\n}", "function name(|\n)",
		"local x: function(a|\n)", "local c = [a|\n]",
	])
	{
		assert.strictEqual(typeFirst(text), null, text);
	}
	// A closer typed first is not an element, and the cursor must be at the end of what was typed.
	assert.strictEqual(typeFirst("function f()|\n)"), null);
	assert.strictEqual(multiline.planFirstElement("function f(abc\n)", 0, 13, ML, "    ", "\n"), null, "the cursor is not at the end");
	// The settings switch each kind off.
	assert.strictEqual(typeFirst("function name(a|\n)", { params: false, tables: true }), null);
	assert(typeFirst("function name(a|\n)", { params: true, tables: false }));
	assert.strictEqual(typeFirst("local t = { a|\n}", { params: true, tables: false }), null);
	assert(typeFirst("local t = { a|\n}", { params: false, tables: true }));
});

test("multiline format: Enter after an element adds the comma and keeps the indentation", function ()
{
	const enter = (text) => applyPlan(text.replace("|", ""), enterAt(text));
	assert.strictEqual(enter("function name(\n    test: bool = false|\n    \n)\nend"), "function name(\n    test: bool = false,\n    |\n)\nend");
	assert.strictEqual(enter("local cfg = {\n    enabled = true|\n    \n}"), "local cfg = {\n    enabled = true,\n    |\n}");
	// The comma goes in front of a comment, and a `--` in a string is no comment.
	assert.strictEqual(enter("local c = {\n    a = 1 -- first |\n    \n}"), "local c = {\n    a = 1, -- first \n    |\n}");
	assert.strictEqual(enter('local c = {\n    a = "x -- y"|\n    \n}'), 'local c = {\n    a = "x -- y",\n    |\n}');
	// An existing comma (or `;` in a table) is not doubled; only the cursor moves.
	for (const text of ["local c = {\n    a = 1,|\n    \n}", "local c = {\n    a = 1;|\n    \n}", "local c = {\n    a = 1, -- c|\n    \n}", "function f(\n    a,|\n    \n)\nend"])
	{
		const plan = enterAt(text);
		assert.deepStrictEqual(plan.edits, [], text);
		assert.deepStrictEqual(plan.cursor, { line: text.slice(0, text.indexOf("|")).split("\n").length, col: 4 });
	}
	// `;` is no separator of parameters.
	assert.strictEqual(enterAt("function f(\n    a;|\n    \n)\nend").edits[0].text, ",");
	// Indentation of the new line follows the element, also when the editor did not indent it.
	assert.strictEqual(applyPlan("local c = {\n    a = 1\n\n}", enterAt("local c = {\n    a = 1|\n\n}")), "local c = {\n    a = 1,\n    |\n}");
	assert.strictEqual(applyPlan("local c = {\n\t\ta = 1\n\t\t\t\n}", enterAt("local c = {\n\t\ta = 1|\n\t\t\t\n}")), "local c = {\n\t\ta = 1,\n\t\t|\n}");
	// Nested tables work on their own level.
	assert.strictEqual(enter("local c = {\n    inner = {\n        a = 1|\n        \n    }\n}"), "local c = {\n    inner = {\n        a = 1,\n        |\n    }\n}");
	assert.strictEqual(enter("local c = {\n    inner = {\n        a = 1,\n    }|\n    \n}"), "local c = {\n    inner = {\n        a = 1,\n    },\n    |\n}");
	// A function in a table: the element after `end` gets a comma, its statements do not.
	assert.strictEqual(enter("local c = {\n    f = function()\n        return 1\n    end|\n    \n}"), "local c = {\n    f = function()\n        return 1\n    end,\n    |\n}");
	// Not in a list, or not at the end of an element.
	for (const text of [
		"foo(\n    a|\n    \n)",                                   // call arguments
		"local c = {\n    \n    |\n}",                              // an empty line: only a line break
		"local c = {\n    inner = {|\n        \n    }\n}",           // the line opens a table itself
		"function name(|\n    \n)\nend",                           // the line opens the parameters
		"local c = {\n    f = function()\n        return 1|\n        \n    end\n}", // statement in a function
		"local c = {\n    a = 1 +|\n    \n}",                      // the expression goes on
		"local c = {\n    a = 1 and|\n    \n}", "local c = {\n    a =|\n    \n}", "function f(\n    a:|\n    \n)\nend", "local c = {\n    a = b..|\n    \n}",
		"local f = |x| -> int {\n    return x|\n    \n}",         // body of a lambda
		"local c = {\n    a = 1|\n",                              // no closer
		"if x then\n    a = 1|\n    \nend",                       // not a list
		"local c = [\n    a|\n    \n]",
	])
	{
		assert.strictEqual(enterAt(text), null, text);
	}
	// `...` is the last parameter: no comma. A nullable type ending in `?` is an element.
	assert.deepStrictEqual(enterAt("function f(\n    a,\n    ...|\n    \n)\nend").edits, []);
	assert.strictEqual(enterAt("function f(\n    a: int?|\n    \n)\nend").edits[0].text, ",");
	// Types in the parameters are no function bodies.
	assert.strictEqual(enterAt("function f(\n    cb: function(x: int): int|\n    \n)\nend").edits[0].text, ",");
	assert.strictEqual(enterAt("$type F = function(a: string): int\nlocal c = {\n    a = 1|\n    \n}").edits[0].text, ",");
	// Loops and blocks inside a table's function do not confuse it.
	assert.strictEqual(enterAt("local c = {\n    f = function()\n        for i = 1, 3 do\n            x = i|\n            \n        end\n    end,\n}"), null);
	assert.strictEqual(enterAt("local c = {\n    f = function() for i = 1, 3 do end end|\n    \n}").edits[0].text, ",");
	// The settings switch each kind off.
	assert.strictEqual(enterAt("function f(\n    a|\n    \n)\nend", { params: false, tables: true }), null);
	assert.strictEqual(enterAt("local c = {\n    a|\n    \n}", { params: true, tables: false }), null);
	assert(enterAt("local c = {\n    a|\n    \n}", { params: false, tables: true }));
});

test("multiline format: the settings exist and are on by default", function ()
{
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const props = pkg.contributes.configuration.properties;
	for (const key of ["plua.format.multilineParams", "plua.format.multilineTables"])
	{
		assert.strictEqual(props[key].type, "boolean");
		assert.strictEqual(props[key].default, true);
		assert(props[key].markdownDescription.includes("%" + key + ".markdownDescription%"));
	}
});

const defaults = require("../src/defaultValues");

/** The parameter under the cursor (`@` marks it; `|` is needed in union types). */
function paramIn(textWithCursor)
{
	const offset = textWithCursor.indexOf("@");
	const text = textWithCursor.replace("@", "");
	const info = defaults.paramAt(text, offset);
	return info && { name: info.name, type: info.typeText, hasDefault: info.hasDefault, written: text.slice(info.typeStart, info.typeEnd) };
}

test("default values: the parameter with a type under the cursor", function ()
{
	assert.deepStrictEqual(paramIn("function name(test: bool@)"), { name: "test", type: "bool", hasDefault: false, written: "bool" });
	assert.deepStrictEqual(paramIn("function name(test: bool @)").type, "bool");
	assert.deepStrictEqual(paramIn("function name(a, test: bool@, c)").name, "test");
	assert.deepStrictEqual(paramIn("function name(a: int, b: Vehicle@)").type, "Vehicle");
	assert.deepStrictEqual(paramIn("function name(te@st: bool)").name, "test", "anywhere on the parameter");
	assert.deepStrictEqual(paramIn("function name(test: int?@)").type, "int?");
	assert.deepStrictEqual(paramIn("function name(test: ?string@)").type, "?string");
	assert.deepStrictEqual(paramIn("function name(p: { x: int, y: int }@)").type, "{ x: int, y: int }");
	assert.deepStrictEqual(paramIn("function name(...rest: any@)").name, "rest");
	assert.deepStrictEqual(paramIn("local f = function(t: bool@)").name, "t");
	assert.deepStrictEqual(paramIn("function obj.sub:method(t: bool@)").name, "t");
	// A union: the `|` of the type is no part of the cursor mark.
	const union = defaults.paramAt("function name(test: int|string)", "function name(test: int|string".length);
	assert.strictEqual(union.typeText, "int|string");
	// With a default value, or typed on several lines.
	assert.deepStrictEqual(paramIn("function name(test: bool = false@)").hasDefault, true);
	assert.deepStrictEqual(paramIn("function name(test: bool =@)").hasDefault, true);
	assert.deepStrictEqual(paramIn("function name(\n    test: bool@\n)").name, "test");
	assert.deepStrictEqual(paramIn("function name(test: bool@\nend").name, "test", "an unfinished list");
	// Not on a parameter: after the comma, in the list of a call, a variable, an untyped parameter, a plain list.
	for (const text of [
		"function name(a: int,@ b: bool)", "function name(a: int, b: bool)@", "foo(test: bool@)", "local x: bool@", "function name(test@)",
		"function name(a,@ b)", "function name(@)", "function name(test:@)", "local t = { a: bool@ }", "function name(a: int)\n    local x = (b: c@)",
	])
	{
		assert.strictEqual(paramIn(text), null, text);
	}
	// What is typed on the line below does not leak into the parameter above.
	assert.strictEqual(paramIn("function name(test: bool@\n    , c: int)").type, "bool");
});

test("default values: the values that fit a type", function ()
{
	const isClass = (name) => name == "Vehicle";
	const values = (type) => defaults.defaultValuesFor(type, isClass);
	assert.deepStrictEqual(values("bool"), ["false", "true"]);
	assert.deepStrictEqual(values("boolean"), ["false", "true"]);
	assert.deepStrictEqual(values("int"), ["0", "1", "-1"]);
	assert.deepStrictEqual(values("float"), ["0.0", "1.0", "-1.0"]);
	assert.deepStrictEqual(values("number"), ["0", "1", "-1"]);
	assert.deepStrictEqual(values("string"), ['""']);
	assert.deepStrictEqual(values("table"), ["{}"]);
	assert.deepStrictEqual(values("function"), ["function() end"]);
	assert.deepStrictEqual(values("{ x: int }"), ["{}"]);
	assert.deepStrictEqual(values("any"), ["nil", "false", "0", '""', "{}"]);
	assert.deepStrictEqual(values("Vehicle"), ["new Vehicle()"]);
	// A nullable type: the values first, `nil` last (both spellings of `?`).
	assert.deepStrictEqual(values("int?"), ["0", "1", "-1", "nil"]);
	assert.deepStrictEqual(values("?string"), ['""', "nil"]);
	assert.deepStrictEqual(values("Vehicle?"), ["new Vehicle()", "nil"]);
	assert.deepStrictEqual(values("bool|nil"), ["false", "true", "nil"]);
	// A union offers the values of each member, without repeating one.
	assert.deepStrictEqual(values("int|string"), ["0", "1", "-1", '""']);
	assert.deepStrictEqual(values("int|float|number"), ["0", "1", "-1", "0.0", "1.0", "-1.0"]);
	assert.deepStrictEqual(values("void"), []);
	assert.deepStrictEqual(values("Unknown"), []);
	assert.deepStrictEqual(defaults.splitUnion("int|{ a: int|string }|?bool"), ["int", "{ a: int|string }", "?bool"]);
	// Only a finished type has values: `bo` is still being typed, `int|` is not finished.
	for (const type of ["bool", "int?", "?string", "int|string", "Vehicle", "nil", "{ x: int }", "function(a: int): int"])
	{
		assert(defaults.isCompleteType(type, isClass), type);
	}
	for (const type of ["bo", "", "int|", "Unknown", "Vehicle2"])
	{
		assert(!defaults.isCompleteType(type, isClass), type);
	}
	assert(!defaults.isCompleteType("Vehicle"), "without a class check a name is no type");
});

test("default values: the completion offers them after a complete type", function ()
{
	const key = vscode.Uri.file("/ws/vehicle.pluto").toString();
	index.setFile(key, "/ws/vehicle.pluto", "class Vehicle\n    function __construct()\n    end\nend\n");
	try
	{
		const items = (text, context) => complete(text, context).items.filter(i => String(i.label).startsWith("= "));
		const labels = (text) => items(text).map(i => i.label);
		// Right after the type, with the cursor on its last letter or behind a space.
		assert.deepStrictEqual(labels("function name(test: bool|)"), ["= false", "= true"]);
		assert.deepStrictEqual(labels("function name(test: bool |)"), ["= false", "= true"]);
		assert.deepStrictEqual(labels("function name(a: int, test: int?|, c)"), ["= 0", "= 1", "= -1", "= nil"]);
		assert.deepStrictEqual(labels("function name(test: ?string|)"), ['= ""', "= nil"]);
		assert.deepStrictEqual(labels("function name(test: Vehicle|)"), ["= new Vehicle()"]);
		assert.deepStrictEqual(labels("local f = function(test: table|)"), ["= {}"]);
		// Inserted at the cursor, with a space in front when the cursor touches the type, and not replacing it.
		const [first] = items("function name(test: bool|)");
		assert.strictEqual(first.insertText, " = false");
		assert.strictEqual(first.range.start.character, "function name(test: bool".length);
		assert.strictEqual(first.range.start.character, first.range.end.character);
		assert.strictEqual(first.preselect, true);
		assert.strictEqual(items("function name(test: bool |)")[0].insertText, "= false");
		assert(first.detail.includes("test"));
		// The values come first; the types stay behind them (`bool` can still become `boolean`).
		const all = complete("function name(test: bool|)").items;
		assert.strictEqual(String(all[0].label), "= false");
		assert(all.some(i => i.label == "boolean") && all.some(i => i.label == "bool?"));
		// Not when there is a default value already, in a call, for a variable, for an unfinished type, or in Lua.
		for (const text of [
			"function name(test: bool = false|)", "function name(test: bool =|)", "foo(test: bool|)", "local x: bool|", "function name(test: bo|)",
			"function name(test|)", "function name(a: int,| b)", "function name(test: Unknown|)",
		])
		{
			assert.deepStrictEqual(labels(text), [], text);
		}
		// A space typed by the user does not open it (the timer or Ctrl+Space does).
		assert.deepStrictEqual(items("function name(test: bool |)", { triggerKind: 1, triggerCharacter: " " }), []);
		// The setting switches it off.
		vscode.config["plua.completion.defaultValues"] = false;
		try
		{
			assert.deepStrictEqual(labels("function name(test: bool|)"), []);
		}
		finally
		{
			delete vscode.config["plua.completion.defaultValues"];
		}
	}
	finally
	{
		index.removeFile(key);
	}
});

test("default values: the settings exist, with the colors of the line for dark and light themes", function ()
{
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const props = pkg.contributes.configuration.properties;
	assert.strictEqual(props["plua.highlight.paramNoDefault"].default, true);
	assert.strictEqual(props["plua.highlight.paramNoDefaultColor"].format, "color-hex");
	assert.strictEqual(props["plua.highlight.paramNoDefaultLightColor"].format, "color-hex");
	assert.strictEqual(props["plua.completion.defaultValues"].default, true);
	assert.strictEqual(props["plua.completion.defaultValuesDelayMs"].default, 800);
	assert.strictEqual(props["plua.completion.defaultValuesDelayMs"].minimum, 0);
});

const autoFormat = require("../src/autoFormat");
const AF = { params: true, tables: true };

test("auto format: a new line after the comma of a multi-line list", function ()
{
	const plan = (text, options) => autoFormat.planCommaNewLine(text.replace("|", ""), text.slice(0, text.indexOf("|")).split("\n").length - 1, options || AF, "    ", "\n");
	const run = (textWithCursor, options) =>
	{
		const text = textWithCursor.replace("|", "");
		const p = plan(textWithCursor, options);
		assert(p, "a plan was expected");
		const e = p.edits[0];
		const lines = text.split("\n");
		lines[e.line] = lines[e.line].slice(0, e.col) + e.text + lines[e.line].slice(e.endCol);
		return { text: lines.join("\n"), cursor: p.cursor };
	};
	let r = run("function name(\n    test: bool = false,|\n)\nend");
	assert.strictEqual(r.text, "function name(\n    test: bool = false,\n    \n)\nend");
	assert.deepStrictEqual(r.cursor, { line: 2, col: 4 });
	r = run("local cfg = {\n    enabled = true,| -- on\n}");
	assert.strictEqual(r.text, "local cfg = {\n    enabled = true, -- on\n    \n}", "the comment stays in place");
	// The first element is on the line of the bracket: the next one goes one level deeper.
	r = run("function name(a,|\n)");
	assert.strictEqual(r.text, "function name(a,\n    \n)");
	r = run("  local t = { a = 1,|\n  }");
	assert.deepStrictEqual(r.cursor, { line: 1, col: 6 });
	// A table element above others: the line for the next one is added between them.
	r = run("local t = {\n    a = 1,|\n    b = 2\n}");
	assert.strictEqual(r.text, "local t = {\n    a = 1,\n    \n    b = 2\n}");
	// Tab and CRLF come from the caller.
	const tab = autoFormat.planCommaNewLine("local t = { a = 1,\n}", 0, AF, "\t", "\r\n");
	assert.strictEqual(tab.edits[0].text, "\r\n\t");
	// Not: a one-line list, a call, a line that is there already, no comma at the end, a lambda body, the settings.
	for (const text of [
		"function name(a,| b)", "local t = { a = 1,| b = 2 }", "foo(\n    a,|\n)", "local t = {\n    a = 1,|\n    \n}", "local t = {\n    a = 1|\n}",
		"local f = |x| -> int {\n    return x,|\n}", "if x then\n    y = 1,|\nend", "local t = {\n    a = \"x,\"|\n}",
	])
	{
		assert.strictEqual(plan(text), null, text);
	}
	assert.strictEqual(plan("function name(\n    a,|\n)", { params: false, tables: true }), null);
	assert.strictEqual(plan("local t = {\n    a,|\n}", { params: true, tables: false }), null);
	assert(plan("local t = {\n    a,|\n}", { params: false, tables: true }));
});

test("auto format: the suggestions shown in grey", function ()
{
	const all = { parens: true, keyAssign: true, blockWords: true };
	const at = (textWithCursor, options) =>
	{
		const offset = textWithCursor.indexOf("@");
		const s = autoFormat.inlineSuggestionAt(textWithCursor.replace("@", ""), offset, options || all);
		return s && [s.kind, s.insert, s.snippet || null];
	};
	// `()` after `function`, with or without a name.
	for (const text of ["function@", "function name@", "function obj.sub:method@", "local f = function@", "foo(function@)", "  local function name@", "x = {\n    f = function@\n}", "local g = function@ -- c".replace(" -- c", "")])
	{
		assert.deepStrictEqual(at(text), ["parens", "()", "($0)"], text);
	}
	for (const text of [
		"function@()", "function name@(a)", "functions@", "local function@", "public function@", "export function@", "x: function@", "local t: int|function@", "-- function@",
		"\"function@\"", "function name(@", "myfunction@", "obj.function@",
	])
	{
		assert.strictEqual(at(text), null, text);
	}
	// ` = ` after the key of a table field.
	assert.deepStrictEqual(at("local t = { [\"a\"]@ }"), ["key", " = ", null]);
	assert.deepStrictEqual(at("local t = {\n    [\"a\"]@\n}"), ["key", " = ", null]);
	assert.deepStrictEqual(at("local t = { x = 1, [2]@"), ["key", " = ", null]);
	assert.deepStrictEqual(at("local t = {\n    x = 1,\n    ['k']@\n}"), ["key", " = ", null]);
	for (const text of ["t[\"a\"]@", "local t = { [\"a\"]@ = 1 }", "local t = {\n    x = 1\n    [2]@\n}", "local x = t[\"a\"]@", "print([\"a\"]@)", "local t = { f([\"a\"]@) }"])
	{
		assert.strictEqual(at(text), null, text);
	}
	// ` then` and ` do` after the header of a block; the space is not doubled.
	assert.deepStrictEqual(at("if x@"), ["then", " then", null]);
	assert.deepStrictEqual(at("if x @"), ["then", "then", null]);
	assert.deepStrictEqual(at("    elseif a and b@"), ["then", " then", null]);
	assert.deepStrictEqual(at("if f(x) == 1@"), ["then", " then", null]);
	assert.deepStrictEqual(at("while n < 3@"), ["do", " do", null]);
	assert.deepStrictEqual(at("for i = 1, 10@"), ["do", " do", null]);
	assert.deepStrictEqual(at("for k, v in pairs(t)@"), ["do", " do", null]);
	for (const text of [
		"if x then@", "if x then y end@", "if@", "if a and@", "if f(@", "if (a@", "while@", "while x do@", "for@", "for k@", "for i =@", "for i = 1@", "x = 1@", "-- if x@", "if x@ == 1",
		"print(\"if x\"@",
	])
	{
		assert.strictEqual(at(text), null, text);
	}
	// Each kind is a setting.
	assert.strictEqual(at("function@", { parens: false, keyAssign: true, blockWords: true }), null);
	assert.strictEqual(at("local t = { [\"a\"]@ }", { parens: true, keyAssign: false, blockWords: true }), null);
	assert.strictEqual(at("if x@", { parens: true, keyAssign: true, blockWords: false }), null);
});

test("auto format: names written twice", function ()
{
	const dups = (text) => autoFormat.findDuplicates(text).map(d => d.kind + ":" + d.name + "@" + d.line + ":" + d.col + "<" + d.firstLine);
	assert.deepStrictEqual(dups("function f(a, a) end"), ["param:a@0:14<0"]);
	assert.deepStrictEqual(dups("function f(a: int, b, a: string) end"), ["param:a@0:22<0"]);
	assert.deepStrictEqual(dups("function f(\n    a: int,\n    a: int\n)\nend"), ["param:a@2:4<1"]);
	assert.deepStrictEqual(dups("function obj:method(x, y, x) end"), ["param:x@0:26<0"]);
	assert.deepStrictEqual(dups("local f = function(x, y, x) end"), ["param:x@0:25<0"]);
	assert.deepStrictEqual(dups("local f = |a, b, a| -> a"), ["param:a@0:17<0"]);
	assert.deepStrictEqual(dups("local f = |a: int, b: int, a: int| -> a"), ["param:a@0:27<0"]);
	assert.deepStrictEqual(dups("function f(a, ...rest, a) end"), ["param:a@0:23<0"]);
	assert.deepStrictEqual(dups("function f(a, a, a) end").length, 2, "every repetition");
	// Table keys: names and `[\"name\"]` are the same key, numbers are keys of their own.
	assert.deepStrictEqual(dups("local t = { a = 1, b = 2, a = 3 }"), ["key:a@0:26<0"]);
	assert.deepStrictEqual(dups("local t = { a = 1, [\"a\"] = 2 }"), ["key:a@0:20<0"]);
	assert.deepStrictEqual(dups("local t = { [1] = 1, [1] = 2 }"), ["key:1@0:22<0"]);
	assert.deepStrictEqual(dups("local t = {\n    a = 1,\n    b = 2,\n    a = 3\n}"), ["key:a@3:4<1"]);
	assert.deepStrictEqual(dups("local t = { 1, 2, a = 1, a = 2 }"), ["key:a@0:25<0"]);
	// What is no repetition: other lists, nested tables, calls, values, one name in a call.
	for (const text of [
		"foo(a, a)", "local x = a | b | a", "function f(a = g(b, b), b) end", "local t = { a = 1, inner = { a = 2 } }", "local t = { x = { y = 1 }, y = 2 }",
		"local t = { a = 1, a }", "local t = { [f(1)] = 1, [f(1)] = 2 }", "local t = { {a = 1}, {a = 2} }", "local t = { f(a = 1), a = 1 }", "function f(a, b, c) end",
		"function f(a) local a = 1 end", "local s = \"function f(a, a)\"", "-- function f(a, a)",
	])
	{
		assert.deepStrictEqual(dups(text), [], text);
	}
});

test("auto format: the diagnostics of names written twice and of closers that do not fit", function ()
{
	const run = (text, options) => lintSource(text, { path: "/ws/a.pluto", requires: [] }, { index: { files: new Map(), resolveModule: () => null } }, Object.assign({ requires: false, calls: false }, options));
	const dup = run("function f(a, a) end\nlocal t = { x = 1, x = 2 }", { duplicates: "warning" });
	assert.deepStrictEqual(dup.map(p => [p.line, p.col, p.severity, p.code]), [[0, 14, "warning", "duplicate-param"], [1, 19, "warning", "duplicate-key"]]);
	assert(dup[0].message.includes("Parameter 'a' is already declared (line 1)"), dup[0].message);
	assert(dup[1].message.includes("Key 'x' is already set"), dup[1].message);
	assert.strictEqual(run("function f(a, a) end", { duplicates: "error" })[0].severity, "error");
	assert.deepStrictEqual(run("function f(a, a) end", { duplicates: "off" }), []);
	assert.deepStrictEqual(run("function f(a, a) end", {}), [], "without the option nothing is checked");
	const brackets = run("local t = { a = 1 ]\nlocal u = (1 }", { brackets: "suggest" });
	assert.deepStrictEqual(brackets.map(p => [p.line, p.col, p.severity, p.code]), [[0, 18, "error", "bracket-mismatch"], [1, 13, "error", "bracket-mismatch"]]);
	assert(brackets[0].message.includes("Expected '}'") && brackets[0].message.includes("line 1") && brackets[0].message.includes("found ']'"), brackets[0].message);
	assert.deepStrictEqual(run("local t = { a = 1 ]", { brackets: "off" }), []);
	assert.strictEqual(run("local t = { a = 1 ]", { brackets: "auto" }).length, 1, "auto reports it as well");
	// A forgotten closer, a stray one, strings and comments are not closers that do not fit.
	for (const text of ["local t = { a[1 }", "x = )", "local s = \"{]\"", "-- { ]", "local t = { a[1] }", "foo(a, b)"])
	{
		assert.deepStrictEqual(run(text, { brackets: "suggest" }), [], text);
	}
	const mismatches = autoFormat.findBracketMismatches("local t = { f(1, 2] }");
	assert.deepStrictEqual([mismatches[0].found, mismatches[0].expected, mismatches[0].openLine], ["]", ")", 0]);
	// Russian texts.
	require("../src/i18n").setLanguage("ru");
	try
	{
		assert(run("function f(a, a) end", { duplicates: "warning" })[0].message.includes("Параметр 'a' уже объявлен"));
		assert(run("x = { ]", { brackets: "suggest" })[0].message.includes("Ожидалась '}'"));
	}
	finally
	{
		require("../src/i18n").setLanguage("en");
	}
});

test("auto format: the settings exist", function ()
{
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const props = pkg.contributes.configuration.properties;
	assert.strictEqual(props["plua.format.newLineAfterComma"].default, true);
	assert.strictEqual(props["plua.format.newLineAfterCommaDelayMs"].default, 700);
	assert.strictEqual(props["plua.format.suggestParens"].default, true);
	assert.strictEqual(props["plua.format.suggestTableKeyAssign"].default, true);
	assert.strictEqual(props["plua.format.suggestBlockWords"].default, true);
	assert.strictEqual(props["plua.format.fixMismatchedBrackets"].default, "suggest");
	assert.deepStrictEqual(props["plua.format.fixMismatchedBrackets"].enum, ["off", "suggest", "auto"]);
	assert.strictEqual(props["plua.format.fixMismatchedBrackets"].enumDescriptions.length, 3);
	assert.strictEqual(props["plua.format.fixMismatchedBracketsDelayMs"].default, 1200);
	assert.strictEqual(props["plua.diagnostics.duplicateParams"].default, "warning");
	assert.deepStrictEqual(props["plua.diagnostics.duplicateParams"].enum, ["warning", "error", "off"]);
});

test("for: the suggestions while the header is written", function ()
{
	const af = autoFormat;
	const all = { parens: true, keyAssign: true, blockWords: true, forHints: true };
	const at = (textWithCursor, options) =>
	{
		const offset = textWithCursor.indexOf("@");
		return af.inlineSuggestionsAt(textWithCursor.replace("@", ""), offset, Object.assign({}, all, options || {}));
	};
	const inserts = (text, options) => at(text, options).map(s => s.kind + ":" + s.insert);
	// After `for`: the kinds of loop.
	assert.deepStrictEqual(inserts("for@"), [
		"for-numeric: i = 1, 10", "for-ipairs: i, v in ipairs(t)", "for-pairs: k, v in pairs(t)", "for-as: t as v",
	]);
	assert.deepStrictEqual(inserts("for @"), ["for-numeric:i = 1, 10", "for-ipairs:i, v in ipairs(t)", "for-pairs:k, v in pairs(t)", "for-as:t as v"]);
	// The nearest table of the file: its name, its length, and the way through it that fits (an array: ipairs first).
	assert.deepStrictEqual(inserts("local items = { 1, 2, 3 }\nfor @"), [
		"for-numeric:i = 1, #items", "for-ipairs:i, v in ipairs(items)", "for-pairs:k, v in pairs(items)", "for-as:items as v",
	]);
	assert.deepStrictEqual(inserts("local cfg = { a = 1, b = 2 }\nfor @"), [
		"for-numeric:i = 1, #cfg", "for-pairs:k, v in pairs(cfg)", "for-ipairs:i, v in ipairs(cfg)", "for-as:cfg as v",
	]);
	assert.strictEqual(af.nearestTable("local a = { 1 }\nlocal b = { x = 1 }\nfor ", "local a = { 1 }\nlocal b = { x = 1 }\nfor ".length).name, "b", "the nearest one");
	assert.strictEqual(af.nearestTable("local t = { [1] = 1 }\nfor ", 25).array, false);
	assert.strictEqual(af.nearestTable("local t = {}\nfor ", 16).array, false, "an empty one is no array to go through");
	assert.strictEqual(af.nearestTable("x.y = { 1 }\nfor ", 16), null, "a field is not a variable");
	assert.strictEqual(af.nearestTable("local t = { 1 }\nfor ", 14), null, "only what is above the line");
	// Snippets: the places to fill in.
	assert.strictEqual(at("for@")[0].snippet, " ${1:i} = ${2:1}, ${3:10}");
	assert.strictEqual(at("for@")[2].snippet, " ${1:k}, ${2:v} in pairs(${3:t})");
	// After `in`: what to walk with.
	assert.deepStrictEqual(inserts("for k, v in@"), ["for-ipairs: ipairs(t)", "for-pairs: pairs(t)", "for-next: next, t"]);
	assert.deepStrictEqual(inserts("local cfg = { a = 1 }\nfor k, v in @"), ["for-pairs:pairs(cfg)", "for-ipairs:ipairs(cfg)", "for-next:next, cfg"]);
	// The limit of a numeric loop, only when there is a table to measure; then its step, up or down.
	assert.deepStrictEqual(inserts("for i = 1,@"), []);
	assert.deepStrictEqual(inserts("local items = { 1, 2 }\nfor i = 1,@"), ["for-limit: #items"]);
	assert.deepStrictEqual(inserts("for i = 1, 10,@"), ["for-step: 1", "for-step: 2"]);
	assert.deepStrictEqual(inserts("for i = 10, 1,@"), ["for-step: -1", "for-step: -2"]);
	assert.deepStrictEqual(inserts("for i = a, b,@"), ["for-step: 1", "for-step: -1"]);
	assert.deepStrictEqual(inserts("for i = f(1, 2),@"), [], "a comma inside a call is no comma of the header");
	assert.deepStrictEqual(inserts("for i = f(1, 2), 5,@"), ["for-step: 1", "for-step: -1"]);
	// A finished header: ` do`, as before. Nothing for what is no header, in a comment or a string, or at the end of a longer line.
	assert.deepStrictEqual(inserts("for i = 1, 3@"), ["do: do"]);
	for (const text of ["for x@", "fora@", "for i = 1, 3 do@", "-- for@", "\"for@\"", "for@ i = 1", "format@", "x = for@", "for k, v in pairs(t)@ do"])
	{
		assert.deepStrictEqual(inserts(text), text == "for k, v in pairs(t)@ do" || text == "for@ i = 1" || text == "x = for@" ? inserts(text) : [], text);
	}
	assert.deepStrictEqual(inserts("for@ i = 1"), []);
	assert.deepStrictEqual(inserts("x = for@"), []);
	// The setting switches the loop hints off; ` do` stays with the block words.
	assert.deepStrictEqual(inserts("for@", { forHints: false }), []);
	assert.deepStrictEqual(inserts("for i = 1, 3@", { forHints: false }), ["do: do"]);
});

test("for: full words and the words of your own", function ()
{
	const af = autoFormat;
	assert.deepStrictEqual(af.namesFor("short"), { index: "i", key: "k", value: "v", table: "t" });
	assert.deepStrictEqual(af.namesFor("full"), { index: "index", key: "key", value: "value", table: "table_name" });
	assert.deepStrictEqual(af.namesFor("anything"), af.namesFor("short"));
	// Own words replace single ones; what is no name or is reserved is ignored.
	assert.deepStrictEqual(af.namesFor("full", { value: "item", table: "list" }), { index: "index", key: "key", value: "item", table: "list" });
	assert.deepStrictEqual(af.namesFor("short", { key: "end", value: "1x", index: "my index", table: 5 }), af.namesFor("short"));
	assert.deepStrictEqual(af.namesFor("short", null), af.namesFor("short"));
	const run = (text, names) => af.inlineSuggestionsAt(text, text.length, { forHints: true, names }).map(s => s.insert);
	assert.deepStrictEqual(run("for ", af.namesFor("full")), ["index = 1, 10", "index, value in ipairs(table_name)", "key, value in pairs(table_name)", "table_name as value"]);
	assert.deepStrictEqual(run("for k in ", af.namesFor("full")), ["ipairs(table_name)", "pairs(table_name)", "next, table_name"]);
	assert.deepStrictEqual(run("for ", af.namesFor("short", { value: "item", table: "list" })), ["i = 1, 10", "i, item in ipairs(list)", "k, item in pairs(list)", "list as item"]);
	// A table of the file wins over the word for the table.
	assert.deepStrictEqual(run("local rows = { 1 }\nfor ", af.namesFor("full")), ["index = 1, #rows", "index, value in ipairs(rows)", "key, value in pairs(rows)", "rows as value"]);
	// The settings are declared.
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const props = pkg.contributes.configuration.properties;
	assert.strictEqual(props["plua.format.nameStyle"].default, "short");
	assert.deepStrictEqual(props["plua.format.nameStyle"].enum, ["short", "full"]);
	assert.deepStrictEqual(Object.keys(props["plua.format.names"].properties), ["index", "key", "value", "table"]);
	assert.strictEqual(props["plua.format.suggestFor"].default, true);
});

test("if: then or do, by the setting or by what the code uses", function ()
{
	const af = autoFormat;
	// The two spellings are counted, for `if` and `elseif`; strings, comments, calls and fields are not.
	assert.deepStrictEqual(af.countIfStyles("if a then end\nif b do end\nif c do end\nelseif d do end"), { then: 1, do: 3 });
	assert.deepStrictEqual(af.countIfStyles("local s = \"if x then\"\n-- if y do\nobj.if = 1"), { then: 0, do: 0 });
	assert.deepStrictEqual(af.countIfStyles("if f(function() return 1 end) then end\nif g({ a = 1 }) do end"), { then: 1, do: 1 });
	assert.deepStrictEqual(af.countIfStyles("if x\n   and y\nthen\nend"), { then: 1, do: 0 });
	assert.deepStrictEqual(af.countIfStyles(""), { then: 0, do: 0 });
	// The choice: the setting, else the file, else the workspace, else `then`.
	assert.strictEqual(af.chooseIfWord("then", { then: 0, do: 9 }), "then");
	assert.strictEqual(af.chooseIfWord("do", { then: 9, do: 0 }), "do");
	assert.strictEqual(af.chooseIfWord("off", { then: 9, do: 0 }), null);
	assert.strictEqual(af.chooseIfWord("auto", { then: 1, do: 3 }), "do");
	assert.strictEqual(af.chooseIfWord("auto", { then: 3, do: 1 }, { then: 0, do: 9 }), "then", "the file counts more than the workspace");
	assert.strictEqual(af.chooseIfWord("auto", { then: 2, do: 2 }, { then: 0, do: 5 }), "do", "a tie in the file: the workspace decides");
	assert.strictEqual(af.chooseIfWord("auto", { then: 0, do: 0 }, { then: 4, do: 4 }), "then", "a tie everywhere");
	assert.strictEqual(af.chooseIfWord("auto", { then: 0, do: 0 }), "then");
	assert.strictEqual(af.chooseIfWord("whatever", { then: 0, do: 2 }), "do", "an unknown value is auto");
	// The suggestion follows the chosen word; `do` is not asked for twice, and off suggests nothing.
	const word = (text, ifWord) => af.inlineSuggestionsAt(text, text.length, { blockWords: true, ifWord }).map(s => s.kind + ":" + s.insert);
	assert.deepStrictEqual(word("if x"), ["then: then"], "then is the default");
	assert.deepStrictEqual(word("if x", "do"), ["do: do"]);
	assert.deepStrictEqual(word("    elseif a and b", "do"), ["do: do"]);
	assert.deepStrictEqual(word("if x ", "do"), ["do:do"]);
	assert.deepStrictEqual(word("if x", null), []);
	assert.deepStrictEqual(word("if x do", "then"), [], "a header that has its word");
	assert.deepStrictEqual(word("if x then", "do"), []);
	assert.deepStrictEqual(word("while x", "then"), ["do: do"], "a loop takes only do, whatever is chosen");
	assert.deepStrictEqual(word("for i = 1, 3", null), ["do: do"]);
	// The setting.
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const prop = pkg.contributes.configuration.properties["plua.format.ifBlockWord"];
	assert.strictEqual(prop.default, "auto");
	assert.deepStrictEqual(prop.enum, ["auto", "then", "do", "off"]);
	assert.strictEqual(prop.enumDescriptions.length, 4);
});

test("for: the values a numeric loop goes through, shown on hover", function ()
{
	const af = autoFormat;
	const text = (line) => { const d = af.describeNumericFor(line); return d && af.forPreviewText(d); };
	assert.strictEqual(text("for i = 1, 10, 2 do"), "`i` takes the values 1, 3, 5, 7, 9 (5 times, step 2).");
	assert.strictEqual(text("for i = 1, 3"), "`i` takes the values 1, 2, 3 (3 times, step 1).");
	assert.strictEqual(text("for i = 10, 1, -3 do"), "`i` takes the values 10, 7, 4, 1 (4 times, step -3).");
	assert.strictEqual(text("for n = 0, 1, 0.25"), "`n` takes the values 0, 0.25, 0.5, 0.75, 1 (5 times, step 0.25).");
	assert.strictEqual(text("for i = 1, 1 do"), "`i` takes the values 1 (1 time, step 1).");
	assert.strictEqual(text("    for i = 1, 100 do -- many"), "`i` takes the values 1, 2, 3, 4, 5, 6, ..., 100 (100 times, step 1).");
	// `1, 3, 5`: from 1 to 3 with the step 5 is one value.
	assert.strictEqual(text("for i = 1, 3, 5 do"), "`i` takes the values 1 (1 time, step 5). The step 5 is larger than the distance, so the loop runs once.");
	assert(text("for i = 5, 1 do").startsWith("The loop does not run"), text("for i = 5, 1 do"));
	assert(text("for i = 1, 5, -1 do").startsWith("The loop does not run"));
	assert.strictEqual(text("for i = 1, 3, 0 do"), "The step is 0: the loop raises an error.");
	// What is no numeric loop with numbers.
	for (const line of ["for i = 1, #t do", "for i = a, b do", "for k, v in pairs(t) do", "for t as v do", "for i = 1 do", "for i = 1, 2, 3, 4 do", "x = 1, 2", "-- for i = 1, 2"])
	{
		assert.strictEqual(text(line), null, line);
	}
	// In Russian, with the right form of "раз".
	require("../src/i18n").setLanguage("ru");
	try
	{
		assert.strictEqual(text("for i = 1, 10, 2 do"), "`i` принимает значения 1, 3, 5, 7, 9 (5 раз, шаг 2).");
		assert.strictEqual(text("for i = 1, 4"), "`i` принимает значения 1, 2, 3, 4 (4 раза, шаг 1).");
		assert.strictEqual(text("for i = 1, 21").endsWith("(21 раз, шаг 1)."), true, text("for i = 1, 21"));
		assert.strictEqual(text("for i = 1, 1"), "`i` принимает значения 1 (1 раз, шаг 1).");
		assert.strictEqual(text("for i = 1, 3, 0"), "Шаг равен 0: цикл вызовет ошибку.");
	}
	finally
	{
		require("../src/i18n").setLanguage("en");
	}
	// On hover of the keyword `for`, switched off by the setting.
	assert(hover("fo|r i = 1, 10, 2 do end").includes("takes the values 1, 3, 5, 7, 9 (5 times, step 2)"), hover("fo|r i = 1, 10, 2 do end"));
	assert(hover("fo|r i = 1, 3, 5 do end").includes("the loop runs once"));
	assert(!(hover("for i = 1, 10, 2 do end\nx = |1") || "").includes("takes the values"));
	vscode.config["plua.hover.forPreview"] = false;
	try
	{
		assert(!hover("fo|r i = 1, 10, 2 do end").includes("takes the values"));
	}
	finally
	{
		delete vscode.config["plua.hover.forPreview"];
	}
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	assert.strictEqual(pkg.contributes.configuration.properties["plua.hover.forPreview"].default, true);
});

const settingsModel = require("../src/settingsModel");
const settingsPanel = require("../src/settingsPanel");

function readManifest()
{
	return {
		pkg: JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")),
		nls: JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.json"), "utf8")),
		nlsRu: JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.ru.json"), "utf8")),
	};
}

test("settings panel: every setting is on exactly one tab with the right control", function ()
{
	const { pkg, nls } = readManifest();
	const props = pkg.contributes.configuration.properties;
	const titles = { general: "General" };
	const model = settingsModel.buildModel(pkg, nls, (key) => props[key].default, titles);
	// All the tabs of the model are known ones, in order, and each setting is shown once (the deprecated ones are not).
	const known = settingsModel.TABS.map(t => t.id);
	assert.deepStrictEqual(model.tabs.map(t => t.id), known.filter(id => model.tabs.some(t => t.id == id)));
	assert.strictEqual(model.tabs[0].title, "General");
	assert.strictEqual(model.tabs[1].title, "index", "a tab without a title shows its id");
	const shown = model.tabs.flatMap(t => t.items.map(i => i.key));
	assert.strictEqual(new Set(shown).size, shown.length, "no setting twice");
	const deprecated = Object.keys(props).filter(k => props[k].deprecationMessage || props[k].markdownDeprecationMessage);
	assert.deepStrictEqual(Object.keys(props).filter(k => !shown.includes(k)).sort(), deprecated.sort(), "everything but the deprecated ones is on a tab");
	// The tab of a setting, and the control it gets.
	const where = (key) => model.tabs.find(t => t.items.some(i => i.key == key)).id;
	const item = (key) => model.tabs.flatMap(t => t.items).find(i => i.key == key);
	assert.strictEqual(where("plua.language"), "general");
	assert.strictEqual(where("plua.workspace.ignoreFiles"), "index");
	assert.strictEqual(where("plua.lua.compilerPath"), "compilers");
	assert.strictEqual(where("plua.compilers.list"), "compilers");
	assert.strictEqual(item("plua.compilers.list").kind, "compilers");
	assert.strictEqual(where("plua.lua.enable"), "general");
	assert.strictEqual(where("plua.completion.defaultValues"), "completion");
	assert.strictEqual(where("plua.hover.forPreview"), "hover");
	assert.strictEqual(where("plua.outline.calls"), "outline");
	assert.strictEqual(where("plua.diagnostics.duplicateParams"), "diagnostics");
	assert.strictEqual(where("plua.highlight.colors"), "highlight");
	assert.strictEqual(where("plua.format.ifBlockWord"), "typing");
	assert.strictEqual(where("plua.json.files"), "json");
	assert.strictEqual(item("plua.autoCloseBlocks").kind, "boolean");
	assert.strictEqual(item("plua.format.ifBlockWord").kind, "enum");
	assert.strictEqual(item("plua.index.maxFiles").kind, "number");
	assert.strictEqual(item("plua.workspace.exclude").kind, "list");
	assert.strictEqual(item("plua.lua.compilerPath").kind, "text");
	assert.strictEqual(item("plua.highlight.paramNoDefaultColor").kind, "color");
	assert.strictEqual(item("plua.highlight.nullableTypeColor").kind, "color");
	assert.strictEqual(item("plua.highlight.colors").kind, "colors");
	assert.strictEqual(item("plua.highlight.tableBracketColors").kind, "bracketColors");
	assert.strictEqual(item("plua.format.names").kind, "map");
	assert.deepStrictEqual(item("plua.format.names").fields, ["index", "key", "value", "table"]);
	assert.deepStrictEqual(item("plua.format.ifBlockWord").options.map(o => o.value), ["auto", "then", "do", "off"]);
	assert.strictEqual(item("plua.index.maxFiles").min, 1);
	assert.strictEqual(item("plua.highlight.colors").categories.length, 11);
	assert.strictEqual(item("plua.highlight.colors").categories[0].name, "functionName");
	// The texts are the ones of the nls file; no `%key%` is left over.
	assert.strictEqual(item("plua.json.severity").description, nls["plua.json.severity.markdownDescription"]);
	assert(model.tabs.flatMap(t => t.items).every(i => !/^%.*%$/.test(i.description) && i.description.length > 0), "every setting has its text");
	assert(model.tabs.flatMap(t => t.items).filter(i => i.options).every(i => i.options.every(o => o.label && !/^%/.test(o.label))));
	// The value of a setting is the one in force.
	const changed = settingsModel.buildModel(pkg, nls, (key) => key == "plua.format.suggestFor" ? false : props[key].default, {});
	assert.strictEqual(changed.tabs.flatMap(t => t.items).find(i => i.key == "plua.format.suggestFor").value, false);
	assert.strictEqual(settingsModel.tabOf("plua.something.new"), "general", "a setting no tab claims lands on the first tab");
});

test("settings panel: only allowed values are saved", function ()
{
	const { pkg } = readManifest();
	const check = (key, value) => settingsModel.validateChange(pkg, key, value);
	const ok = (key, value) => { const r = check(key, value); assert(r.ok, key + " " + JSON.stringify(value) + " " + r.error); return r; };
	const bad = (key, value) => { const r = check(key, value); assert(!r.ok, key + " " + JSON.stringify(value) + " should be refused"); return r.error; };
	// Which settings may be written: ours, and only the ones that exist.
	bad("editor.fontSize", 20);
	bad("plua.nothing", true);
	bad("__proto__", true);
	bad("constructor", true);
	// Switches, choices, numbers, texts.
	assert.strictEqual(ok("plua.autoCloseBlocks", false).isDefault, false);
	assert.strictEqual(ok("plua.autoCloseBlocks", true).isDefault, true, "the default is not written to settings.json");
	bad("plua.autoCloseBlocks", "yes");
	assert.strictEqual(ok("plua.format.ifBlockWord", "do").value, "do");
	bad("plua.format.ifBlockWord", "later");
	assert.strictEqual(ok("plua.index.maxFiles", "250").value, 250, "a number arrives as text from the field");
	assert.strictEqual(ok("plua.index.maxFiles", 12.7).value, 13, "an integer setting is rounded");
	bad("plua.index.maxFiles", 0);
	bad("plua.index.maxFiles", "many");
	bad("plua.format.newLineAfterCommaDelayMs", 99999);
	assert.strictEqual(ok("plua.lua.compilerPath", "C:/lua/luac.exe").value, "C:/lua/luac.exe");
	bad("plua.lua.compilerPath", 5);
	// Colors: a hex color, an empty one goes back to the default.
	assert.strictEqual(ok("plua.highlight.paramNoDefaultColor", "#ff8800").value, "#ff8800");
	assert.strictEqual(ok("plua.highlight.paramNoDefaultColor", "#F80").value, "#F80");
	assert.strictEqual(ok("plua.highlight.paramNoDefaultColor", "#ff880080").value, "#ff880080");
	assert.strictEqual(ok("plua.highlight.paramNoDefaultColor", "").isDefault, true);
	bad("plua.highlight.paramNoDefaultColor", "orange");
	bad("plua.highlight.paramNoDefaultColor", "#12");
	// Lists are trimmed, empty lines go.
	assert.deepStrictEqual(ok("plua.workspace.exclude", [" **/vendor/** ", "", "  "]).value, ["**/vendor/**"]);
	bad("plua.workspace.exclude", "**/vendor/**");
	bad("plua.workspace.exclude", [1]);
	// The colors of the highlighting: every part is checked, an empty one is dropped, a transparent one is refused.
	const colors = ok("plua.highlight.colors", { functionName: { color: "#ff8800", lightColor: "#007a62", fontStyle: "bold", darkColor: "" }, type: {}, keyword: "#c586c0 bold" });
	assert.deepStrictEqual(colors.value, { functionName: { color: "#ff8800", lightColor: "#007a62", fontStyle: "bold" }, keyword: "#c586c0 bold" });
	assert.strictEqual(ok("plua.highlight.colors", {}).isDefault, true);
	bad("plua.highlight.colors", { functionName: { color: "#0000" } });
	bad("plua.highlight.colors", { functionName: { color: "blue" } });
	bad("plua.highlight.colors", { functionName: { fontStyle: "bolt" } });
	bad("plua.highlight.colors", { notACategory: { color: "#ff8800" } });
	bad("plua.highlight.colors", []);
	bad("plua.highlight.colors", "#ff8800");
	assert.deepStrictEqual(ok("plua.highlight.tableBracketColors", [{ color: "#e6b450" }, {}, "#59c2ff"]).value, [{ color: "#e6b450" }, "#59c2ff"]);
	bad("plua.highlight.tableBracketColors", [{ color: "#0000" }]);
	bad("plua.highlight.tableBracketColors", "#ff8800");
	// The words of your own.
	assert.deepStrictEqual(ok("plua.format.names", { value: "item", key: "", table: " list " }).value, { value: "item", table: "list" });
	bad("plua.format.names", { value: "my item" });
	bad("plua.format.names", { other: "x" });
	assert.strictEqual(ok("plua.format.names", {}).isDefault, true);
	// The answers are in the language in use.
	require("../src/i18n").setLanguage("ru");
	try
	{
		assert.strictEqual(bad("plua.format.newLineAfterCommaDelayMs", 99999), "ожидается число от 0 до 10000");
		assert.strictEqual(bad("plua.format.ifBlockWord", "later"), "это не один из вариантов");
	}
	finally
	{
		require("../src/i18n").setLanguage("en");
	}
	assert.strictEqual(bad("plua.format.newLineAfterCommaDelayMs", 99999), "a number from 0 to 10000 is expected");
});

test("settings panel: the page", function ()
{
	const { pkg, nls } = readManifest();
	const props = pkg.contributes.configuration.properties;
	const model = settingsModel.buildModel(pkg, nls, (key) => props[key].default, settingsPanel.tabTitles());
	// A description that tries to be HTML must not reach the page as HTML: the data is base64 in a data block.
	model.tabs[0].items[0].description = "<script>alert(1)</script></script><img src=x onerror=alert(2)>";
	const html = settingsPanel.renderHtml(model, settingsPanel.panelStrings(), "NONCE42", "vscode-webview://x");
	assert(html.includes("script-src 'nonce-NONCE42'") && html.includes("style-src 'nonce-NONCE42'") && html.includes("default-src 'none'"), "a strict content security policy");
	assert(!html.includes("alert(1)") && !html.includes("onerror"), "nothing of the data is in the page as text");
	assert(!/'unsafe-/.test(html), "no unsafe sources");
	assert.strictEqual((html.match(/<script/g) || []).length, 2, "the data block and the script");
	assert(html.split("<script").slice(1).every(part => part.startsWith(' nonce="NONCE42"') || part.startsWith(' type="application/json"')), "every script has the nonce or is data");
	const b64 = /<script type="application\/json" id="data">([^<]+)<\/script>/.exec(html)[1];
	assert(/^[A-Za-z0-9+/=]+$/.test(b64.trim()));
	const data = JSON.parse(Buffer.from(b64.trim(), "base64").toString("utf8"));
	assert.strictEqual(data.model.tabs[0].items[0].description, "<script>alert(1)</script></script><img src=x onerror=alert(2)>", "it arrives unchanged, for textContent");
	assert.strictEqual(data.strings.title, "Pluto & Lua Mini-IDE settings");
	// Non-latin texts survive the trip.
	require("../src/i18n").setLanguage("ru");
	try
	{
		const ru = settingsPanel.renderHtml(model, settingsPanel.panelStrings(), "N", "x");
		const back = JSON.parse(Buffer.from(/id="data">([^<]+)</.exec(ru)[1].trim(), "base64").toString("utf8"));
		assert.strictEqual(back.strings.title, "Pluto & Lua Mini-IDE: настройки");
		assert(ru.includes('lang="ru"'));
	}
	finally
	{
		require("../src/i18n").setLanguage("en");
	}
	// The script of the page is valid, and builds the page with text nodes only.
	const source = fs.readFileSync(path.join(__dirname, "..", "src", "settingsClient.js"), "utf8");
	assert.doesNotThrow(() => new (require("vm").Script)(source));
	assert(!/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\(/.test(source), "no way to put text into the page as HTML");
	assert(!source.includes("</script"), "it can sit in a script element");
	// The command is declared and has a title in both languages.
	const { nlsRu } = readManifest();
	assert(pkg.contributes.commands.some(c => c.command == "plua.openSettings"));
	assert(pkg.activationEvents.includes("onCommand:plua.openSettings"));
	assert.strictEqual(nls["command.openSettings.title"], "Plua: Settings");
	assert.strictEqual(nlsRu["command.openSettings.title"], "Plua: Настройки");
	// The tabs have titles in both languages.
	for (const tab of settingsModel.TABS)
	{
		assert(settingsPanel.tabTitles()[tab.id] && settingsPanel.tabTitles()[tab.id] != "settings.tab." + tab.id, tab.id);
	}
});

const hints = require("../src/hints");

/** A text with `@` for the cursor → [text, offset]. */
function cursorIn(textWithCursor)
{
	const offset = textWithCursor.indexOf("@");
	assert(offset != -1, "missing cursor marker");
	return [textWithCursor.replace("@", ""), offset];
}

test("hints: a parameter without a type, with the colon suggested", function ()
{
	const name = (s) => { const [t, o] = cursorIn(s); const r = hints.untypedParamAt(t, o); return r && r.name; };
	assert.strictEqual(name("function f(a, value2@)"), "value2");
	assert.strictEqual(name("function f(value2@"), "value2", "an unfinished list");
	assert.strictEqual(name("function f(\n    value: bool = false,\n    value1: any = 1,\n    value2@\n)"), "value2", "typed above it");
	assert.strictEqual(name("function f(a@, b)"), "a");
	assert.strictEqual(name("function f(a, @b)"), "b", "anywhere on the name");
	assert.strictEqual(name("function f(valu@e2)"), "value2");
	assert.strictEqual(name("local f = function(x@)"), "x");
	assert.strictEqual(name("function obj:method(x@)"), "x");
	assert.strictEqual(name("function f(a, ...rest@)"), "rest");
	// Not: typed, with a default value, `self`, a lambda, a call, reserved words, a variable.
	for (const text of ["function f(a: int@)", "function f(a = 1@)", "function f(self@)", "function f(...@)", "foo(a@)", "function f(end@)", "local x@", "function f(a, @)", "function f(a@: int)"])
	{
		assert.strictEqual(name(text), null, text);
	}
	// The suggestion: after the name, in front of `,` or `)`, with the list of types opened by Tab.
	const all = { paramType: true, returnType: true, returnValue: true, caseColon: true, caseBreak: true, caseWords: true };
	const sug = (s, options) => { const [t, o] = cursorIn(s); return hints.suggestionsAt(t, o, options || all, { unit: "    " }); };
	let found = sug("function f(a, value2@)");
	assert.deepStrictEqual(found.map(s => [s.kind, s.insert, s.paused, s.command]), [["param-colon", ": ", true, "editor.action.triggerSuggest"]]);
	assert.deepStrictEqual(sug("function f(a, value2@, b)").map(s => s.kind), ["param-colon"]);
	assert.deepStrictEqual(sug("function f(a, value2 @)").map(s => s.kind), ["param-colon"], "behind a space");
	assert.deepStrictEqual(sug("function f(a, val@ue2)"), [], "not in the middle of the name");
	assert.deepStrictEqual(sug("function f(a: int@)"), []);
	assert.deepStrictEqual(sug("function f(a, value2@)", Object.assign({}, all, { paramType: false })), []);
	assert.deepStrictEqual(sug("-- function f(a, value2@)"), [], "in a comment");
});

test("hints: a return type after the parameters, and the values of a return", function ()
{
	const all = { paramType: true, returnType: true, returnValue: true, caseColon: true, caseBreak: true, caseWords: true };
	const kinds = (s, options, extra) => { const t = s.replace("@", ""); return hints.suggestionsAt(t, s.indexOf("@"), options || all, extra || {}).map(x => x.kind + ":" + x.insert); };
	// The colon behind the `)` of a function that has no return type.
	assert.deepStrictEqual(kinds("function f(a)@"), ["return-colon:: "]);
	assert.deepStrictEqual(kinds("function f(a) @"), ["return-colon:: "]);
	assert.deepStrictEqual(kinds("function f()@\nend"), ["return-colon:: "]);
	assert.deepStrictEqual(kinds("function obj:m(a, b)@"), ["return-colon:: "]);
	assert.deepStrictEqual(kinds("local f = function(x)@"), ["return-colon:: "]);
	assert.deepStrictEqual(kinds("function f(a)@ return a end"), ["return-colon:: "]);
	for (const text of ["function f(a): int@", "function f(a)@: int", "foo(a)@", "local x = (1)@", "$declare function f(a)@", "x: function(a)@", "if (a)@"])
	{
		assert.deepStrictEqual(kinds(text), [], text);
	}
	assert.deepStrictEqual(kinds("function f(a)@", Object.assign({}, all, { returnType: false })), []);
	// `return `: the values of the type of the function around, nullable ones with nil, and none for void or no type.
	const values = (s, isClass) => { const t = s.replace("@", ""); return hints.returnValuesAt(t, s.indexOf("@"), isClass); };
	assert.deepStrictEqual(values("function f(): bool\n    return @\nend"), ["false", "true"]);
	assert.deepStrictEqual(values("function f(): int?\n    return @\nend"), ["0", "1", "-1", "nil"]);
	assert.deepStrictEqual(values("function f(): ?string\n    return @\nend"), ["\"\"", "nil"]);
	assert.deepStrictEqual(values("function f(): bool|nil\n    return @\nend"), ["false", "true", "nil"]);
	assert.deepStrictEqual(values("function f(): string\n    if x then\n        return @\n    end\nend"), ["\"\""], "inside of a block");
	assert.deepStrictEqual(values("function f(): Vehicle\n    return @\nend", n => n == "Vehicle"), ["new Vehicle()"]);
	assert.deepStrictEqual(values("class A\n    function m(a: int): table\n        return @\n    end\nend"), ["{}"]);
	assert.deepStrictEqual(values("function f(): bool\n    local g = function(): int\n        return @\n    end\nend"), ["0", "1", "-1"], "the nearest function");
	for (const text of ["function f(): void\n    return @\nend", "function f()\n    return @\nend", "return @", "function f(): bool\n    return @true\nend", "function f(): Unknown\n    return @\nend"])
	{
		assert.deepStrictEqual(values(text), [], text);
	}
	assert.deepStrictEqual(kinds("function f(): bool\n    return @\nend"), ["return-value:false", "return-value:true"]);
	assert.deepStrictEqual(kinds("function f(): bool\n    return@\nend"), [], "only after the space");
	assert.deepStrictEqual(kinds("function f(): bool\n    return @\nend", Object.assign({}, all, { returnValue: false })), []);
});

test("hints: a function that does not return what it says", function ()
{
	const problems = (s) => hints.findReturnProblems(s).map(p => p.kind + ":" + p.type + "@" + p.line + ":" + p.col);
	assert.deepStrictEqual(problems("function f(): int\n    local x = 1\nend"), ["missing:int@0:14"]);
	assert.deepStrictEqual(problems("function f(a: int): string|number\n    local x = 1\nend"), ["missing:string|number@0:20"]);
	assert.deepStrictEqual(problems("class A\n    function m(): int\n        local z = 1\n    end\nend"), ["missing:int@1:18"]);
	assert.deepStrictEqual(problems("function f(): { int }\n    local z = 1\nend"), ["missing:{ int }@0:14"]);
	assert.deepStrictEqual(problems("function f(): int\n    local g = function() return 5 end\nend"), ["missing:int@0:14"], "the return of an inner function is not its own");
	assert.deepStrictEqual(problems("function f(): void\n    return 1\nend"), ["void-value:void@1:4"]);
	assert.deepStrictEqual(problems("function f(): void\n    return\nend"), []);
	assert.deepStrictEqual(problems("function f(): void\n    if x then return end\nend"), []);
	// Fine: it returns, it raises an error or jumps, its type may be nothing, or it has no body.
	for (const text of [
		"function f(): int\n    return 1\nend", "function f(): int\n    if x then return 1 end\n    return 2\nend", "function f(): int\n    error(\"x\")\nend",
		"function f(): int?\nlocal x\nend", "function f(): ?int\n    local x\nend", "function f(): int|nil\n    local x\nend", "function f(): any\n    local x\nend",
		"function f(): int\nend", "function f()\n    local x\nend", "$declare function f(): int\nfunction g(): bool\n    return true\nend", "local f: function(): int = nil",
	])
	{
		assert.deepStrictEqual(problems(text), [], text);
	}
	assert.deepStrictEqual(problems("function f(): int\n    while true do\n        x = 1\n    end\nend"), ["missing:int@0:14"], "a loop is not a return");
	assert.deepStrictEqual(problems("function f(): int\n    for i = 1, 3 do\n        return i\n    end\nend"), []);
});

test("hints: switch and case", function ()
{
	const all = { paramType: true, returnType: true, returnValue: true, caseColon: true, caseBreak: true, caseWords: true };
	const kinds = (s, options) => { const t = s.replace("@", ""); return hints.suggestionsAt(t, s.indexOf("@"), options || all, { unit: "    " }).map(x => x.kind + ":" + x.insert + (x.paused ? "~" : "")); };
	// The colon after the values, shown at once like the `()` of a `function`; not when it is there, or where the line goes on.
	assert.deepStrictEqual(kinds("switch x do\n    case 1@\nend"), ["case-colon::"]);
	assert.deepStrictEqual(kinds("switch x do\n    case 2, 3@\nend"), ["case-colon::"]);
	assert.deepStrictEqual(kinds("switch x do\n    case \"a\"@\nend"), ["case-colon::"]);
	assert.deepStrictEqual(kinds("switch x do\n    case 1 @\nend"), ["case-colon::"]);
	for (const text of ["switch x do\n    case 1:@\nend", "switch x do\n    case @\nend", "case 1@", "if x then\n    case 1@\nend", "switch x do\n    case f(@\nend", "switch x do\n    case 1,@\nend", "switch x do\n    case 1@ -- c\nend"])
	{
		assert.deepStrictEqual(kinds(text).filter(k => k.startsWith("case-colon")), [], text);
	}
	// The yellow line: under `case`, wherever the cursor is on its line.
	const noColon = (s) => { const t = s.replace("@", ""); const r = hints.caseNoColonAt(t, s.indexOf("@")); return r && [r.line, r.col, r.endCol].join(":"); };
	assert.strictEqual(noColon("switch x do\n    ca@se 1\nend"), "1:4:8");
	assert.strictEqual(noColon("switch x do\n    case 1@\nend"), "1:4:8");
	assert.strictEqual(noColon("switch x do\n    case 1:@\nend"), null);
	assert.strictEqual(noColon("x = 1@"), null);
	// `break`: on an empty line inside of the body of a `case` that nothing ends, before another case, `default` or `end`.
	const brk = (s) => kinds(s).filter(k => k.startsWith("case-break"));
	assert.deepStrictEqual(brk("switch x do\n    case 1:\n        print(1)\n        @\n    case 2:\n        break\nend"), ["case-break:break"]);
	assert.deepStrictEqual(brk("switch x do\n    case 1:\n        @\nend"), ["case-break:break"]);
	assert.deepStrictEqual(brk("switch x do\n    case 1:\n        for i = 1, 3 do\n            print(i)\n        end\n        @\n    case 2:\nend"), ["case-break:break"], "a loop in the body");
	assert.deepStrictEqual(brk("switch x do\n    case 1:\n        if y then\n            print()\n        end\n        @\n    default:\nend"), ["case-break:break"]);
	for (const text of [
		"switch x do\n    case 1:\n        print(1)\n        break\n        @\n    case 2:\nend",        // ended already
		"switch x do\n    case 1:\n        return\n        @\n    case 2:\nend", "switch x do\n    case 1:\n        goto done\n        @\nend", "switch x do\n    case 1:\n        error(\"x\")\n        @\nend",
		"switch x do\n    default:\n        @\nend",                                                       // default needs none
		"switch x do\n    case 1:\n    @\n    case 2:\nend",                                               // not in the body
		"switch x do\n    case 1:\n        print(1)\n        @\n        print(2)\nend",                  // something follows
		"switch x do\n    case 1:\n        for i = 1, 3 do\n            break\n        end\n        @\n    case 2:\nend", // a break in the loop is a break of the case too: left alone
		"if x then\n    @\nend",
	])
	{
		assert.deepStrictEqual(brk(text), [], text);
	}
	// `case ` and `default:` at the level of the cases.
	const words = (s) => kinds(s).filter(k => k.startsWith("case-word"));
	assert.deepStrictEqual(words("switch x do\n    @\nend"), ["case-word:case ", "case-word:default:"]);
	assert.deepStrictEqual(words("switch x do\n    case 1:\n        break\n    @\nend"), ["case-word:case ", "case-word:default:"]);
	assert.deepStrictEqual(words("switch x do\n    case 1:\n        break\n    default:\n        print(1)\n    @\nend"), ["case-word:case "], "one default");
	assert.deepStrictEqual(words("switch x do\n    case 1:\n        for i = 1, 2 do\n        end\n    @\nend"), ["case-word:case ", "case-word:default:"]);
	for (const text of ["switch x do\n    case 1:\n        break\n        @\nend", "switch x do\n@\nend", "if x then\n    @\nend", "switch x do\n    case 1:\n        print(@)\nend"])
	{
		assert.deepStrictEqual(words(text), [], text);
	}
	assert.deepStrictEqual(kinds("switch x do\n    case 1:\n        break\n    @\nend", Object.assign({}, all, { caseWords: false })), []);
	assert.deepStrictEqual(brk("switch x do\n    case 1:\n        @\nend").length, 1);
	assert.deepStrictEqual(kinds("switch x do\n    case 1:\n        @\nend", Object.assign({}, all, { caseBreak: false })), []);
	// Cases that run into the next one: an empty body is a group of cases, and a `break` in a nested block counts.
	const falls = (s) => hints.findCaseFallthroughs(s).map(p => p.line + ":" + p.col);
	assert.deepStrictEqual(falls("switch x do\n    case 1:\n        print(1)\n    case 2:\n        print(2)\n        break\nend"), ["1:4"]);
	assert.deepStrictEqual(falls("switch x do\n    case 1:\n        print(1)\n    default:\n        print()\nend"), ["1:4"]);
	assert.deepStrictEqual(falls("switch a do\n    case 1:\n        switch b do\n            case 2:\n                print()\n            case 3:\n                break\n        end\n        break\nend"), ["3:12"], "the inner switch is its own");
	for (const text of [
		"switch x do\n    case 1:\n        print(1)\n        break\n    case 2:\n        print(2)\nend", "switch x do\n    case 1:\n    case 2:\n        break\nend",
		"switch x do\n    case 1:\n        if y then break end\n    case 2:\n        return\n    default:\n        print()\nend", "switch x do\n    case 1:\n        error(\"x\")\n    case 2:\n        break\nend",
		"switch x do\n    case 1:\n        for i = 1, 3 do\n            print(i)\n        end\n        break\n    case 2:\n        break\nend", "if x then\n    print(1)\nend",
	])
	{
		assert.deepStrictEqual(falls(text), [], text);
	}
});

test("hints: the diagnostics and the settings", function ()
{
	const run = (text, options) => lintSource(text, { path: "/ws/a.pluto", requires: [] }, { index: { files: new Map(), resolveModule: () => null } }, Object.assign({ requires: false, calls: false }, options));
	const returns = run("function a(): int\n    local x = 1\nend\nfunction b(): void\n    return 1\nend", { returnTypes: "warning" });
	assert.deepStrictEqual(returns.map(p => [p.line, p.severity, p.code]), [[0, "warning", "return-missing"], [4, "warning", "return-void-value"]]);
	assert(returns[0].message.includes("returns `int`") && returns[0].message.includes("`return`"), returns[0].message);
	assert(returns[1].message.includes("`void`"), returns[1].message);
	assert.strictEqual(run("function a(): int\n    local x = 1\nend", { returnTypes: "error" })[0].severity, "error");
	assert.deepStrictEqual(run("function a(): int\n    local x = 1\nend", { returnTypes: "off" }), []);
	assert.deepStrictEqual(run("function a(): int\n    local x = 1\nend", {}), [], "nothing without the option");
	const fall = run("switch x do\n    case 1:\n        print(1)\n    case 2:\n        break\nend", { caseFallthrough: "hint" });
	assert.deepStrictEqual(fall.map(p => [p.line, p.severity, p.code]), [[1, "hint", "case-fallthrough"]]);
	assert.deepStrictEqual(run("switch x do\n    case 1:\n        print(1)\n    case 2:\n        break\nend", { caseFallthrough: "off" }), []);
	// Russian texts.
	require("../src/i18n").setLanguage("ru");
	try
	{
		assert(run("function a(): int\n    local x = 1\nend", { returnTypes: "warning" })[0].message.includes("возвращает `int`"));
		assert(run("switch x do\n    case 1:\n        print(1)\n    case 2:\n        break\nend", { caseFallthrough: "hint" })[0].message.includes("переходит в следующий"));
	}
	finally
	{
		require("../src/i18n").setLanguage("en");
	}
	// The settings are declared, with texts in both languages (the test above that checks them all is the other half).
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const props = pkg.contributes.configuration.properties;
	for (const key of ["suggestParamType", "suggestReturnType", "suggestReturnValue", "suggestCaseColon", "suggestCaseBreak", "suggestCaseWords"])
	{
		assert.strictEqual(props["plua.format." + key].default, true, key);
	}
	assert.strictEqual(props["plua.format.suggestParamTypeDelayMs"].default, 600);
	assert.strictEqual(props["plua.highlight.paramNoType"].default, true);
	assert.strictEqual(props["plua.highlight.caseNoColon"].default, true);
	assert.deepStrictEqual(props["plua.diagnostics.returnTypes"].enum, ["warning", "error", "off"]);
	assert.deepStrictEqual(props["plua.diagnostics.caseFallthrough"].enum, ["off", "hint"]);
	assert.strictEqual(props["plua.diagnostics.caseFallthrough"].default, "off");
});

test("hints: a constructor is suggested for a class that has none", function ()
{
	const h = require("../src/hints");
	const at = (s) => h.constructorSuggestionsAt(s.replace("@", ""), s.indexOf("@")).map((x) => x.kind + ":" + x.insert);
	assert.deepStrictEqual(at("class A\n    @\nend"), ["ctor:function __construct()"]);
	assert.deepStrictEqual(at("class A\n    function@\nend"), ["ctor: __construct()"]);
	// extends: the second variant calls the parent's constructor
	const ext = h.constructorSuggestionsAt("class A extends B\n    \nend", 22);
	assert.deepStrictEqual(ext.map((x) => x.kind), ["ctor", "ctor-parent"]);
	assert(ext[1].snippet.includes("parent:__construct($2)"));
	// nothing: a constructor exists, inside a method, outside of a class, not in the body, another word
	assert.deepStrictEqual(at("class A\n    function __construct()\n    end\n    @\nend"), []);
	assert.deepStrictEqual(at("class A\n    function __construct()\n    end\n    function@\nend"), []);
	assert.deepStrictEqual(at("class A\n    function m()\n        @\n    end\nend"), []);
	assert.deepStrictEqual(at("function f()\n    @\nend"), []);
	assert.deepStrictEqual(at("class A\n@\nend"), []);
	assert.deepStrictEqual(at("class A\n    function foo@\nend"), []);
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	assert.strictEqual(pkg.contributes.configuration.properties["plua.format.suggestConstructor"].default, true);
});

test("Shift+Backspace deletes from below: last token of the line below, then the emptied line", function ()
{
	const { belowTokenRange, mergeLineRanges } = require("../src/extension");
	const range = (a, b, c, d) => ({ from: { line: a, character: b }, to: { line: c, character: d } });
	const of = (lines, line, ch) => belowTokenRange((n) => lines[n], lines.length, line, ch);
	// the reference example, press by press (tabs, the cursor stays on line 2)
	let lines = ["switch test do", "\tcase", "", "\tdefault:", "end"];
	const history = [lines];
	const press = function ()
	{
		const r = of(lines, 2, 0);
		const flat = lines.join("\n");
		const off = (p) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
		lines = (flat.slice(0, off(r.from)) + flat.slice(off(r.to))).split("\n");
		history.push(lines);
	};
	press();
	assert.deepStrictEqual(lines, ["switch test do", "\tcase", "", "\tdefault", "end"], "the `:` goes, the tab stays");
	press();
	assert.deepStrictEqual(lines, ["switch test do", "\tcase", "", "\t", "end"], "the word goes whole, the tab stays");
	press();
	assert.deepStrictEqual(lines, ["switch test do", "\tcase", "", "end"], "the emptied line goes");
	press();
	assert.deepStrictEqual(lines, ["switch test do", "\tcase", "", ""], "`end` goes");
	// each press is one edit: going back is just the previous state
	assert.strictEqual(history.length, 5);
	// the same with spaces, and trailing spaces
	assert.deepStrictEqual(of(["", "    default:  "], 0, 0), range(1, 11, 1, 14));
	assert.deepStrictEqual(of(["", "    default  "], 0, 0), range(1, 4, 1, 13));
	assert.deepStrictEqual(of(["", "    "], 0, 0), range(0, 0, 1, 4));
	assert.deepStrictEqual(of(["x", "", "y"], 0, 1), range(0, 1, 1, 0), "an empty line below goes");
	assert.deepStrictEqual(of(["x = foo(a, b)", "\tprint(b)"], 0, 13), range(1, 8, 1, 9));
	// cursor in the middle of a line with code: the nearest token to the right
	assert.deepStrictEqual(of(["foo bar(x)", "\tz"], 0, 3), range(0, 3, 0, 7));
	assert.deepStrictEqual(of(["foo(x)", "\tz"], 0, 3), range(0, 3, 0, 4));
	// spaces to the right only: the line below is what counts
	assert.deepStrictEqual(of(["foo   ", "\tz"], 0, 3), range(1, 1, 1, 2));
	// nothing below
	assert.strictEqual(of(["foo"], 0, 3), null);
	// cursors that delete the same text are joined
	assert.deepStrictEqual(mergeLineRanges([range(0, 5, 3, 0), range(0, 5, 2, 0), range(6, 1, 7, 0)]), [range(0, 5, 3, 0), range(6, 1, 7, 0)]);
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	assert.ok(pkg.contributes.keybindings.some(k => k.command == "plua.deleteFromBelow" && k.key == "shift+backspace" && k.when == "editorTextFocus && !editorReadonly"));
	assert.strictEqual(pkg.contributes.configuration.properties["plua.shiftBackspaceDeleteFromBelow.enabled"].default, true);
});

test("plua.compilers.list: validation of the panel and choice of the first existing entry", function ()
{
	const settingsModel = require("../src/settingsModel");
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	assert.strictEqual(pkg.contributes.configuration.properties["plua.compilers.list"].scope, "machine", "a workspace cannot pick the program");
	const ok = settingsModel.validateChange(pkg, "plua.compilers.list", [{ language: "lua", path: " lua5.4 " }, { language: "lua", path: "lua5.4" }, { language: "pluto", path: "" }]);
	assert.ok(ok.ok);
	assert.deepStrictEqual(ok.value, [{ language: "lua", path: "lua5.4" }], "trimmed, merged, empty dropped");
	assert.ok(settingsModel.validateChange(pkg, "plua.compilers.list", []).isDefault);
	for (const bad of [[{ language: "php", path: "x" }], [{ language: "lua", path: "lua & calc" }], [{ language: "lua", path: "a" + String.fromCharCode(10) + "b" }], [{ language: "lua", path: "x", extra: 1 }], "lua"])
	{
		assert.strictEqual(settingsModel.validateChange(pkg, "plua.compilers.list", bad).ok, false, JSON.stringify(bad));
	}
	const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "plua-list-"));
	const exe = path.join(dir, process.platform == "win32" ? "mylua.exe" : "mylua");
	fs.writeFileSync(exe, "");
	fs.chmodSync(exe, 0o755);
	const picked = compiler.pickFromList([{ language: "lua", path: path.join(dir, "missing") }, { language: "pluto", path: exe }, { language: "lua", path: exe }], "lua", []);
	assert.strictEqual(picked.path, exe);
	assert.strictEqual(picked.problems.length, 1);
	assert.strictEqual(compiler.pickFromList([{ language: "pluto", path: exe }], "lua", []).path, null);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("layoutFixer: Э and э open strings, the Russian text inside stays", function ()
{
	const fx = require("../src/layoutFixer");
	const layout = fx.buildLayout({});
	const run = (text, opts, lay) => fx.applyEdits(text, fx.convertRange(text, 0, text.length, lay || layout, opts || {}));
	assert.strictEqual(run("дщсфд ы = ЭПриветЭ"), "local s = \"Привет\"");
	assert.strictEqual(run("дщсфд ы = эПриветэ"), "local s = 'Привет'");
	assert.strictEqual(run("зкште(ЭДобрый деньЭ)"), "print(\"Добрый день\")", "the text with a space stays whole");
});

test("layoutFixer: live typing converts keys in code only", function ()
{
	const fx = require("../src/layoutFixer");
	const layout = fx.buildLayout({});
	const live = (before, ch, opts) => { const r = fx.liveChange(before + ch, before.length, layout, Object.assign({ mode: "live" }, opts)); return r ? r.text : null; };
	assert.strictEqual(live("x = ", "Э"), "\"");
	assert.strictEqual(live("x = ", "э"), "'");
	assert.strictEqual(live("", "ф"), "a");
	assert.strictEqual(live("", "Ф"), "A");
	assert.strictEqual(live("x = ", "х"), "[");
	assert.strictEqual(live("x = \"При", "Э"), "\"", "closes the string it is in");
	assert.strictEqual(live("x = 'При", "э"), "'");
	assert.strictEqual(live("x = \"При", "э"), null, "э does not close a double-quoted string");
	assert.strictEqual(live("x = \"", "Э"), null, "an empty string: Э is a letter");
	assert.strictEqual(live("x = \"При", "Э", { autoCloseCyrillicQuotes: false }), null);
	assert.strictEqual(live("x = \"При", "ф"), null, "inside a string");
	assert.strictEqual(live("-- коммент", "ф"), null, "inside a comment");
	assert.strictEqual(live("--[[ коммент\nещё ", "ф"), null, "inside a block comment");
	assert.strictEqual(live("x = [[текст ", "ф"), null, "inside a long string");
	assert.strictEqual(live("-- коммент", "ф", { ignoreComments: false }), "a");
	assert.strictEqual(live("-- коммент\nx = ", "ф"), "a", "a comment ends with its line");
	assert.strictEqual(live("x = ", "Э", { mode: "off" }), null);
	// The other modes convert only a quote at once; the words wait for a delimiter.
	assert.strictEqual(live("x = ", "Э", { mode: "keywordsOnly" }), "\"");
	assert.strictEqual(live("", "ф", { mode: "allCodeWords" }), null);
	const word = (text, mode) => { const r = fx.wordChange(text, text.length, layout, { mode }); return r ? r.text : null; };
	assert.strictEqual(word("дщсфд", "keywordsOnly"), "local");
	assert.strictEqual(word("руддщ", "keywordsOnly"), null, "hello is not a keyword");
	assert.strictEqual(word("руддщ", "allCodeWords"), "hello");
	assert.strictEqual(word("x = руддщ", "allCodeWords"), "hello");
	assert.strictEqual(word("-- руддщ", "allCodeWords"), null, "a comment");
	assert.strictEqual(word("x = \"руддщ", "allCodeWords"), null, "a string");
	assert.strictEqual(word("abcруддщ", "allCodeWords"), null, "a word that is partly English");
	assert.strictEqual(word("дщсфдюч", "allCodeWords"), "local.x", "ю is the dot key");
	assert.strictEqual(word("дщсфд", "live"), null);
	assert.ok(fx.isDelimiter(" ") && fx.isDelimiter("\n\t") && fx.isDelimiter("(") && !fx.isDelimiter("ф") && !fx.isDelimiter("a"));
});

test("layoutFixer: the three profiles", function ()
{
	const fx = require("../src/layoutFixer");
	const conv = (text, profile, extra) => { const l = fx.buildLayout(Object.assign({ baseKeyboardProfile: profile }, extra)); return fx.applyEdits(text, fx.convertRange(text, 0, text.length, l, {})); };
	assert.strictEqual(conv("х ъ Х Ъ ж Ж б Б ю Ю ё Ё", "physicalQwerty"), "[ ] { } ; : , < . > ` ~");
	assert.strictEqual(conv("х ъ Х Ъ ж Ж б Б ю Ю ё Ё", "hybridSmart"), "[ ] { } ; : б Б ю Ю ё Ё");
	assert.strictEqual(conv("х ъ Х Ъ ж Ж б Б ю Ю ё Ё", "keepLocalPunctuation"), "х ъ Х Ъ ж Ж б Б ю Ю ё Ё");
	for (const profile of ["physicalQwerty", "hybridSmart", "keepLocalPunctuation"])
	{
		assert.strictEqual(conv("ЭфЭ ыы", profile), "\"ф\" ss", profile + ": letters and quotes");
	}
	// The signs of the Russian layout next to Cyrillic letters: only the physical profile turns them into the keys' signs.
	assert.strictEqual(conv("ф.ф,ф", "physicalQwerty"), "a/a?a");
	assert.strictEqual(conv("ф.ф,ф", "hybridSmart"), "a.a,a");
	assert.strictEqual(conv("ф.ф,ф", "keepLocalPunctuation"), "a.a,a");
	assert.strictEqual(conv("а.б . в", "physicalQwerty"), "f/, . d", "a lone . far from letters stays");
	assert.strictEqual(conv("ф;ф", "physicalQwerty"), "a$a");
	assert.strictEqual(conv("ф:ф", "physicalQwerty"), "a^a");
	assert.strictEqual(conv("ф?ф", "physicalQwerty"), "a&a");
	// A custom map goes over the profile.
	assert.strictEqual(conv("ё х", "physicalQwerty", { customMap: { "ё": "~", "х": "" } }), "~ х");
});

test("layoutFixer: Ukrainian and Belarusian layouts", function ()
{
	const fx = require("../src/layoutFixer");
	const conv = (text, layouts) => { const l = fx.buildLayout({ sourceLayouts: layouts }); return fx.applyEdits(text, fx.convertRange(text, 0, text.length, l, {})); };
	assert.strictEqual(conv("і ї Ї ґ", ["uk"]), "s ] } \\");
	assert.strictEqual(conv("єПриветє", ["uk"]), "'Привет'", "є opens a string like э");
	assert.strictEqual(conv("ЄфЄ", ["uk"]), "\"ф\"");
	assert.strictEqual(conv("ў Ў і", ["be"]), "o O s");
	assert.strictEqual(conv("ў", ["ru"]), "ў", "not a Russian key");
	assert.strictEqual(conv("ф ў", ["ru", "be"]), "a o");
	assert.strictEqual(conv("э", ["uk"]), "э", "Ukrainian has no э");
});

test("layoutFixer: the manual command skips comments and strings, and the editor never touches undo/redo", function ()
{
	const fx = require("../src/layoutFixer");
	const { planChange } = require("../src/layoutFixerEditor");
	const layout = fx.buildLayout({});
	const text = "дщсфд ы = 1 -- дщсфд\nдщсфд т = \"дщсфд\" --[[ дщсфд ]] дщсфд";
	assert.strictEqual(fx.applyEdits(text, fx.convertRange(text, 0, text.length, layout, {})), "local s = 1 -- дщсфд\nlocal n = \"дщсфд\" --[[ дщсфд ]] local");
	assert.strictEqual(fx.applyEdits("-- дщсфд", fx.convertRange("-- дщсфд", 0, 8, layout, { ignoreComments: false })), "-- local");
	// A range: the state before it counts (it starts inside a comment).
	const two = "-- дщсфд\nдщсфд";
	assert.strictEqual(fx.applyEdits(two, fx.convertRange(two, 3, two.length, layout, {})), "-- дщсфд\nlocal");
	// Typing: converted, unless the change is an undo or a redo.
	const reasons = require("vscode").TextDocumentChangeReason;
	const options = { enabled: true, mode: "live", sourceLayouts: ["ru"], baseKeyboardProfile: "physicalQwerty", ignoreComments: true, ignoreStrings: true, autoCloseCyrillicQuotes: true, customMap: {} };
	const typed = { rangeLength: 0, text: "ф" };
	assert.deepStrictEqual(planChange("ф", typed, 0, undefined, options), { start: 0, end: 1, text: "a" });
	assert.strictEqual(planChange("ф", typed, 0, reasons.Undo, options), null, "Ctrl+Z");
	assert.strictEqual(planChange("ф", typed, 0, reasons.Redo, options), null, "Ctrl+Y");
	assert.strictEqual(planChange("ф", typed, 0, undefined, Object.assign({}, options, { enabled: false })), null);
	assert.strictEqual(planChange("ф", typed, 0, undefined, Object.assign({}, options, { mode: "off" })), null);
	assert.strictEqual(planChange("фы", { rangeLength: 0, text: "фы" }, 0, undefined, options), null, "a paste is left alone");
	assert.deepStrictEqual(planChange("ф", { rangeLength: 5, text: "ф" }, 0, undefined, options), { start: 0, end: 1, text: "a" }, "a key typed over a selected text is converted too");
	assert.deepStrictEqual(planChange("дщсфд ", { rangeLength: 0, text: " " }, 5, undefined, Object.assign({}, options, { mode: "keywordsOnly" })), { start: 0, end: 5, text: "local" });
});

test("layoutFixer: settings of the panel", function ()
{
	const settingsModel = require("../src/settingsModel");
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const nls = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.json"), "utf8"));
	const nlsRu = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.ru.json"), "utf8"));
	const props = pkg.contributes.configuration.properties;
	const keys = ["enabled", "mode", "baseKeyboardProfile", "sourceLayouts", "ignoreComments", "ignoreStrings", "autoCloseCyrillicQuotes", "customMap"];
	for (const k of keys)
	{
		assert.ok(props["plua.layoutFixer." + k], k);
		assert.strictEqual(settingsModel.tabOf("plua.layoutFixer." + k), "layout");
		const text = props["plua.layoutFixer." + k].markdownDescription.replace(/^%|%$/g, "");
		assert.ok(nls[text] && nlsRu[text], "texts of " + k);
	}
	assert.deepStrictEqual(props["plua.layoutFixer.mode"].enum, ["live", "allCodeWords", "keywordsOnly", "off"]);
	assert.deepStrictEqual(props["plua.layoutFixer.baseKeyboardProfile"].enum, ["physicalQwerty", "hybridSmart", "keepLocalPunctuation"]);
	assert.strictEqual(props["plua.layoutFixer.mode"].default, "live");
	assert.deepStrictEqual(props["plua.layoutFixer.sourceLayouts"].default, ["ru"]);
	assert.ok(pkg.contributes.commands.some(c => c.command == "plua.convertLayout"));
	assert.ok(pkg.activationEvents.includes("onCommand:plua.convertLayout"));
	assert.strictEqual(settingsModel.validateChange(pkg, "plua.layoutFixer.sourceLayouts", ["ru", "uk", "ru"]).value.length, 2);
	assert.strictEqual(settingsModel.validateChange(pkg, "plua.layoutFixer.sourceLayouts", ["de"]).ok, false);
	assert.strictEqual(settingsModel.validateChange(pkg, "plua.layoutFixer.customMap", { "ё": "~" }).ok, true);
	assert.strictEqual(settingsModel.validateChange(pkg, "plua.layoutFixer.customMap", { "ёё": "~" }).ok, false);
	assert.strictEqual(settingsModel.validateChange(pkg, "plua.layoutFixer.customMap", { "ё": 1 }).ok, false);
	assert.strictEqual(settingsModel.validateChange(pkg, "plua.layoutFixer.mode", "nope").ok, false);
});

test("autoIndent: empty lines inside blocks keep their indentation on Enter", function ()
{
	const ai = require("../src/autoIndent");
	const tabs = { insertSpaces: false, tabSize: 4 };
	const spaces = { insertSpaces: true, tabSize: 2 };
	const at = (lines) => (i) => lines[i];
	// switch -> case 1: -> print("one") -> Enter -> the empty line keeps its indentation -> break
	let lines = ["switch x do", "\tcase 1:", "\t\tprint(\"one\")", "", ""];
	assert.deepStrictEqual(ai.planEnter(at(lines), 3, tabs, {}), [{ line: 3, text: "\t\t" }, { line: 4, text: "\t\t" }]);
	lines = ["switch x do", "  case 1:", "    print(\"one\")", "", ""];
	assert.deepStrictEqual(ai.planEnter(at(lines), 3, spaces, {}), [{ line: 3, text: "    " }, { line: 4, text: "    " }], "spaces of the same width as the line above");
	// The editor already kept the whitespace of the left line, only the new line is short.
	lines = ["if x then", "\tprint(1)", "\t", ""];
	assert.deepStrictEqual(ai.planEnter(at(lines), 2, tabs, {}), [{ line: 3, text: "\t" }]);
	// Nothing to do when both are right, or the setting is off.
	lines = ["if x then", "\tprint(1)", "\t", "\t"];
	assert.deepStrictEqual(ai.planEnter(at(lines), 2, tabs, {}), []);
	lines = ["if x then", "\tprint(1)", "", ""];
	assert.deepStrictEqual(ai.planEnter(at(lines), 2, tabs, { preserveEmptyLines: false }), []);
	assert.deepStrictEqual(ai.planEnter(at(lines), 2, tabs, { enabled: false }), []);
	// Enter inside of a line is not for us.
	lines = ["foo(a,", "b)"];
	assert.deepStrictEqual(ai.planEnter(at(lines), 0, tabs, {}), []);
	// Empty lines after openers get one level deeper.
	for (const [opener, deeper] of [["function f(a)", true], ["local function f(a, b): int", true], ["if x then", true], ["else", true], ["elseif y then", true],
		["for i = 1, 3 do", true], ["while true do", true], ["do", true], ["repeat", true], ["foo(", true], ["local t = {", true], ["local f = function(x)", true],
		["switch x do", true], ["class Foo", true], ["try", true], ["catch e then", true], ["case 1:", true], ["default:", true],
		["print(1)", false], ["end", false], ["until x", false], ["if x then return end", false], ["local t = {}", false], ["foo(a, b)", false], ["-- if x then", false], ["print(\"do\")", false]])
	{
		const got = ai.planEnter(at(["\t" + opener, "", ""]), 1, tabs, {});
		assert.deepStrictEqual(got, deeper ? [{ line: 1, text: "\t\t" }, { line: 2, text: "\t\t" }] : [{ line: 1, text: "\t" }, { line: 2, text: "\t" }], opener);
	}
	// The block of the last line with code counts, over other empty lines.
	lines = ["function f()", "\tx()", "", "", ""];
	assert.deepStrictEqual(ai.planEnter(at(lines), 3, tabs, {}), [{ line: 3, text: "\t" }, { line: 4, text: "\t" }]);
	// A line that is the first of the file.
	assert.deepStrictEqual(ai.planEnter(at(["", ""]), 0, tabs, {}), []);
});

test("autoIndent: the line after case and default, by the setting", function ()
{
	const ai = require("../src/autoIndent");
	const tabs = { insertSpaces: false, tabSize: 4 };
	const at = (lines) => (i) => lines[i];
	assert.deepStrictEqual(ai.planEnter(at(["switch x do", "\tcase 1:", ""]), 1, tabs, {}), [{ line: 2, text: "\t\t" }]);
	assert.deepStrictEqual(ai.planEnter(at(["switch x do", "\tdefault:", "\t"]), 1, tabs, {}), [{ line: 2, text: "\t\t" }]);
	assert.deepStrictEqual(ai.planEnter(at(["switch x do", "\tcase 1:", "\t\t"]), 1, tabs, {}), [], "already right");
	assert.deepStrictEqual(ai.planEnter(at(["switch x do", "\tcase 1:", "\t\t"]), 1, tabs, { indentAfterCase: false }), [{ line: 2, text: "\t" }]);
	assert.deepStrictEqual(ai.planEnter(at(["switch x do", "\tcase 1:", ""]), 1, tabs, { indentAfterCase: false }), [{ line: 2, text: "\t" }]);
	assert.deepStrictEqual(ai.planEnter(at(["switch x do", "\tcase 1:", ""]), 1, { insertSpaces: true, tabSize: 3 }, {}), [{ line: 2, text: "\t   " }], "the unit comes from the editor");
	// The empty line below a case label follows the setting too.
	assert.strictEqual(ai.indentForEmptyLine(at(["\tcase 1:", ""]), 1, tabs, { indentAfterCase: false }), "\t");
	assert.strictEqual(ai.indentForEmptyLine(at(["\tcase 1:", ""]), 1, tabs, {}), "\t\t");
	assert.ok(ai.isCaseLine("case 1:") && ai.isCaseLine("\tdefault:") && ai.isCaseLine("case \"a\", \"b\"") && !ai.isCaseLine("local case = 1") && !ai.isCaseLine("-- case 1:"));
});

test("autoIndent: whitespace-only lines for the cleaning on save, settings and registration", function ()
{
	const ai = require("../src/autoIndent");
	const lines = ["a", "\t\t", "", "  ", "\tb"];
	assert.deepStrictEqual(ai.whitespaceOnlyLines((i) => lines[i], lines.length), [{ line: 1, length: 2 }, { line: 3, length: 2 }]);
	assert.strictEqual(ai.indentUnit({ insertSpaces: false, tabSize: 8 }), "\t");
	assert.strictEqual(ai.indentUnit({ insertSpaces: true, tabSize: 2 }), "  ");
	assert.strictEqual(ai.indentUnit({}), "    ");
	const settingsModel = require("../src/settingsModel");
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const nls = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.json"), "utf8"));
	const nlsRu = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.ru.json"), "utf8"));
	const props = pkg.contributes.configuration.properties;
	const defaults = { enabled: true, preserveEmptyLines: true, indentAfterCase: true, trimOnSave: false };
	for (const [k, def] of Object.entries(defaults))
	{
		const prop = props["plua.autoIndent." + k];
		assert.ok(prop && prop.type == "boolean" && prop.default === def, k);
		assert.strictEqual(settingsModel.tabOf("plua.autoIndent." + k), "autoIndent");
		const text = prop.markdownDescription.replace(/^%|%$/g, "");
		assert.ok(nls[text] && nlsRu[text], "texts of " + k);
	}
});

test("autoIndent: a variable called case, a field called do and the Russian signs are not mistaken", function ()
{
	const ai = require("../src/autoIndent");
	assert.strictEqual(ai.isCaseLine("case = 5"), false);
	assert.strictEqual(ai.isCaseLine("case.x = 1"), false);
	assert.strictEqual(ai.isCaseLine("case (1):"), true);
	assert.strictEqual(ai.increasesAfter("x.do"), false);
	assert.strictEqual(ai.increasesAfter("obj:then"), false);
	assert.strictEqual(ai.increasesAfter("for i = 1, 3 do"), true);
	const fx = require("../src/layoutFixer");
	const layout = fx.buildLayout({});
	const text = "ф\"ф";
	assert.strictEqual(fx.applyEdits(text, fx.convertRange(text, 0, text.length, layout, {})), "a\"ф", "a quote in code opens a string, it is never turned into @");
});

test("hints: the grey return-type colon stays at the `)` and does not follow the cursor to empty lines below", function ()
{
	const { returnColonAt } = require("../src/hints");
	const header = "function f(test: bool = true)";
	assert.ok(returnColonAt(header, header.length), "right after the bracket");
	assert.ok(returnColonAt(header + " ", header.length + 1), "after a space");
	assert.strictEqual(returnColonAt(header + "\n", header.length + 1), null, "Enter once");
	assert.strictEqual(returnColonAt(header + "\n\n", header.length + 2), null, "Enter twice");
	assert.strictEqual(returnColonAt(header + "\n\t\nend", header.length + 2), null, "an indented empty line");
});

test("autoReturn: which headers get a `return ` line below the empty line", function ()
{
	const { returnTypeOf } = require("../src/extension");
	for (const [line, type] of [["function is_alive(entity: int): bool", "bool"], ["local function f(a): string", "string"], ["function Car:get(): Car?", "Car?"],
		["function f(a: int = g()): int|string", "int|string"], ["local f = function(x): any", "any"], ["\tpublic function make(id: int): Entity", "Entity"],
		["function f(): bool -- comment", "bool"]])
	{
		assert.strictEqual(returnTypeOf(line), type, line);
	}
	for (const line of ["function log(msg: string): void", "function f()", "function f(a, b)", "if x then", "local t: function", "class Foo", "function f(a) return 1 end"])
	{
		assert.strictEqual(returnTypeOf(line), null, line);
	}
});

test("returnHint: the functions of a text, what their returns hold", function ()
{
	const { findFunctionShapes } = require("../src/hints");
	const shapes = findFunctionShapes("function a(x)\n\treturn x > 1\nend\nfunction b(): int\n\t\n\treturn \nend\nfunction c()\n\treturn {\n\t\ta = 1\n\t}\nend\nfunction d()\n\tlocal f = function() return 1 end\nend\n");
	const by = (key) => shapes.find(s => s.key == key);
	assert.deepStrictEqual([by("a#1").hasColon, by("a#1").retType, by("a#1").returns.length, by("a#1").returns[0].bare], [false, null, 1, false]);
	assert.deepStrictEqual([by("b#1").hasColon, by("b#1").retType, by("b#1").onlyBareReturn], [true, "int", true]);
	assert.strictEqual(by("c#1").returns[0].end > by("c#1").returns[0].valueStart, true);
	assert.ok(by("c#1").returns[0].end > shapes.length, "a table over lines is one statement");
	assert.strictEqual(by("d#1").returns.length, 0, "the return of an inner function is not the outer one's");
	assert.strictEqual(by("#1").returns.length, 1);
	assert.strictEqual(by("d#1").onlyBareReturn, false);
	assert.strictEqual(findFunctionShapes("function a(): bool\n\treturn\nend").find(s => s.key == "a#1").onlyBareReturn, true);
	assert.strictEqual(findFunctionShapes("function a(): bool\n\tprint(1)\n\treturn\nend").find(s => s.key == "a#1").onlyBareReturn, false);
});

test("returnHint: the type a value tells and what the note says", function ()
{
	const rh = require("../src/returnHint");
	const { findFunctionShapes } = require("../src/hints");
	const type = (v) => rh.inferType(v);
	assert.deepStrictEqual(["true", "not x", "self.hp > 0", "a == b", "1", "-5", "0xFF", "3.14", "\"a\"", "'b'", "\"a\" .. x", "new Car(1)", "{ a = 1 }", "nil", "function() end"].map(type),
		["bool", "bool", "bool", "bool", "int", "int", "int", "float", "string", "string", "string", "Car", "table", "nil", "function"]);
	assert.deepStrictEqual(["self.hp", "f(x)", "a and b", "a > 1 or b", ""].map(type), [null, null, null, null, null]);
	const note = (text, name) => { const shape = findFunctionShapes(text).find(s => s.name == name); return rh.describe(shape, text); };
	const { t } = require("../src/i18n");
	assert.strictEqual(note("function f()\n\treturn self.hp > 0\nend", "f").message, t("returnHint.message", "bool", "self.hp > 0"));
	assert.strictEqual(note("function f()\n\treturn self.hp\nend", "f").message, t("returnHint.message", t("returnHint.value"), "self.hp"));
	assert.strictEqual(note("function f()\n\treturn json.decode(io.contents(path), { strict = true })\nend", "f").action, t("returnHint.click"), "long code: the click text");
	assert.strictEqual(note("function f(a)\n\tif a then\n\t\treturn true\n\tend\n\treturn \"no\"\nend", "f").type, "bool" + t("returnHint.or") + "string");
	// What goes when a return is removed: its line, with the break, or only the statement.
	const text = "function f()\n\tlocal x = 1\n\treturn x\nend\n";
	const ret = findFunctionShapes(text)[0].returns[0];
	const range = rh.removalRange(text, ret);
	assert.strictEqual(text.slice(0, range.start) + text.slice(range.end), "function f()\n\tlocal x = 1\nend\n");
	const inline = "function f() return 1 end";
	const r2 = findFunctionShapes(inline)[0].returns[0];
	const g = rh.removalRange(inline, r2);
	assert.strictEqual(inline.slice(0, g.start) + inline.slice(g.end), "function f()  end");
});

test("returnHint: removing the type takes a bare return away, or puts the note on a return with a value", function ()
{
	const rh = require("../src/returnHint");
	const { findFunctionShapes } = require("../src/hints");
	const shapes = (text) => findFunctionShapes(text);
	const flagged = new Set();
	const memory = new Set();
	// The function has its type and the `return ` that was added.
	let r = rh.track(shapes("function f(): int\n\t\n\treturn \nend"), flagged, memory);
	assert.deepStrictEqual([r.removeBare, [...r.flagged]], [[], []]);
	// The type is deleted a letter at a time: nothing happens while a colon stands there.
	r = rh.track(shapes("function f(): in\n\t\n\treturn \nend"), r.flagged, memory);
	r = rh.track(shapes("function f():\n\t\n\treturn \nend"), r.flagged, memory);
	assert.deepStrictEqual([r.removeBare, [...r.flagged]], [[], []]);
	// The colon is gone: the bare return goes.
	r = rh.track(shapes("function f()\n\t\n\treturn \nend"), r.flagged, memory);
	assert.deepStrictEqual(r.removeBare, ["f#1"]);
	// With a value in it, the function gets the note, and keeps it while it stays without a type.
	const memory2 = new Set();
	rh.track(shapes("function g(): bool\n\treturn x > 1\nend"), new Set(), memory2);
	r = rh.track(shapes("function g()\n\treturn x > 1\nend"), new Set(), memory2);
	assert.deepStrictEqual([r.removeBare, [...r.flagged]], [[], ["g#1"]]);
	r = rh.track(shapes("function g()\n\treturn x > 1\n\nend"), r.flagged, memory2);
	assert.deepStrictEqual([...r.flagged], ["g#1"]);
	r = rh.track(shapes("function g(): bool\n\treturn x > 1\nend"), r.flagged, memory2);
	assert.deepStrictEqual([...r.flagged], [], "the type is back");
	// A function that never had a type is left alone, however it looks.
	r = rh.track(shapes("function h()\n\treturn 1\nend\nfunction k()\n\treturn\nend"), new Set(), new Set());
	assert.deepStrictEqual([r.removeBare, [...r.flagged]], [[], []]);
	// `void` in place of the type: a bare return goes too.
	const memory3 = new Set();
	rh.track(shapes("function v(): bool\n\treturn\nend"), new Set(), memory3);
	assert.deepStrictEqual(rh.track(shapes("function v(): void\n\treturn\nend"), new Set(), memory3).removeBare, ["v#1"]);
});

test("returnHint: settings and texts", function ()
{
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const nls = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.json"), "utf8"));
	const nlsRu = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.ru.json"), "utf8"));
	for (const key of ["plua.format.autoReturn", "plua.diagnostics.returnHint"])
	{
		const prop = pkg.contributes.configuration.properties[key];
		assert.ok(prop && prop.type == "boolean" && prop.default === true, key);
		const text = prop.markdownDescription.replace(/^%|%$/g, "");
		assert.ok(nls[text] && nlsRu[text], key);
	}
	const i18n = require("../src/i18n");
	for (const key of ["message", "value", "click", "or", "code", "goto", "remove"])
	{
		assert.notStrictEqual(i18n.t("returnHint." + key), "returnHint." + key, key);
	}
});

test("hints: an empty body, a body with code and a body with a return are told apart", function ()
{
	const { findFunctionShapes } = require("../src/hints");
	const one = (text) => findFunctionShapes(text)[0];
	assert.strictEqual(one("function f(): bool\n\t\nend").bodyEmpty, true);
	assert.strictEqual(one("function f(): bool\n\n\nend").bodyEmpty, true);
	assert.strictEqual(one("function f(): bool\n\treturn\nend").bodyEmpty, false);
	const code = one("function g(a): int\n\t\n\tprint(a)\nend");
	assert.deepStrictEqual([code.bodyEmpty, code.returns.length, code.endLine], [false, 0, 3], "code, no return: one goes before the end");
	assert.strictEqual(one("function h(a): int\n\t\n\treturn a\nend").returns.length, 1, "a return already: nothing is added");
});

test("unknownTypes: a type that is neither built in nor a known class or enum is marked, in parameters, return types and locals", function ()
{
	const known = new Set(["Car"]);
	const index = { files: new Map(), resolveModule: () => null, lookup: (name) => (known.has(name) ? [{ kind: "class" }] : name == "Color" ? [{ kind: "enum" }] : []) };
	const run = (text, mode) => lintSource(text, { path: "/ws/a.pluto", requires: [] }, { index }, { requires: false, calls: false, unknownTypes: mode });
	const names = (text) => run(text, "warning").map(p => [p.line, p.col, p.endCol, p.code, p.severity]);
	// The line of the screenshot: the return type `test` is no type.
	assert.deepStrictEqual(names("public function main(test: bool = true): test\nend"), [[0, 41, 45, "unknown-type", "warning"]]);
	assert.deepStrictEqual(names("function f(a: Foo, b: int|Bar?, c: ?Car, d: Color = nil, e: json.Value): Car\nend").map(x => x[1]), [14, 26]);
	assert.deepStrictEqual(names("local x: Qux = 1\nlocal y: int = 2\nlocal z = c ? a : b").map(x => x[0]), [0]);
	assert.deepStrictEqual(names("function f(e: int = obj:m(), g: string = c ? 1 : 2): void\nend"), [], "a default value is no type");
	assert.deepStrictEqual(names("function f(a: any, b: mixed, c: table, d: nil): thread\nend"), []);
	assert.strictEqual(run("function f(): test\nend", "error")[0].severity, "error");
	assert.deepStrictEqual(run("function f(): test\nend", "off"), []);
	assert.deepStrictEqual(run("function f(): test\nend", undefined), []);
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const prop = pkg.contributes.configuration.properties["plua.diagnostics.unknownTypes"];
	assert.deepStrictEqual([prop.enum, prop.default], [["warning", "error", "off"], "warning"]);
	const nls = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.json"), "utf8"));
	assert.ok(nls[prop.markdownDescription.replace(/^%|%$/g, "")]);
});

test("returnHelper: a bare return goes when the type is missing or no type, never a return with a value", function ()
{
	const rh = require("../src/returnHint");
	const { findFunctionShapes } = require("../src/hints");
	const known = (name) => ["int", "bool", "string", "Car"].includes(name);
	const keys = (text) => rh.emptyReturnsWithoutType(findFunctionShapes(text), known);
	assert.strictEqual(rh.typeIsValid("bool", known), true);
	assert.strictEqual(rh.typeIsValid("int|Car?", known), true);
	assert.strictEqual(rh.typeIsValid("json.Value", known), true, "a dotted name comes from a module");
	assert.strictEqual(rh.typeIsValid("boo", known), false);
	assert.strictEqual(rh.typeIsValid("int|Foo", known), false);
	assert.strictEqual(rh.typeIsValid(null, known), false);
	assert.strictEqual(rh.typeIsValid("void", known), false);
	assert.deepStrictEqual(keys("function a(): boo\n\t\n\treturn \nend"), ["a#1"], "not a type");
	assert.deepStrictEqual(keys("function a()\n\treturn\nend"), ["a#1"], "no type");
	assert.deepStrictEqual(keys("function a(): bool\n\treturn\nend"), [], "a usable type: the return stays");
	assert.deepStrictEqual(keys("function a(): Car\n\treturn\nend"), []);
	assert.deepStrictEqual(keys("function a()\n\treturn 123\nend"), [], "a return with a value is never touched");
	assert.deepStrictEqual(keys("function a()\n\tprint(1)\n\treturn\nend"), [], "only a body that is nothing but the return");
	assert.deepStrictEqual(keys("function a(): void\n\treturn\nend"), [], "void is left to the change of the type");
});

test("returnHelper: the directive #return = <expression>", function ()
{
	const rh = require("../src/returnHint");
	const run = (text, line) => { const d = rh.findDirectives(text).find(x => x.line == line); return d ? rh.applyDirective(text, d, "    ", "\n") : undefined; };
	assert.deepStrictEqual(rh.findDirectives("function f()\n    #return = self.hp > 0\n  #return=1 \n    #return =\n    x = 1\nend"), [{ line: 1, expr: "self.hp > 0" }, { line: 2, expr: "1" }]);
	// No return yet: one is made before the `end`, one level in from the header.
	assert.strictEqual(run("function f()\n    local a = 1\n    #return = self.hp > 0\nend\n", 2), "function f()\n    local a = 1\n    return self.hp > 0\nend\n");
	assert.strictEqual(run("function f()\n    #return = x\n    local a = 1\nend\n", 1), "function f()\n    local a = 1\n    return x\nend\n", "the directive at the top: the return goes to the end");
	// A return at the end takes the expression in, bare or with a value.
	assert.strictEqual(run("function f()\n    return\n    #return = 7\nend\n", 2), "function f()\n    return 7\nend\n");
	assert.strictEqual(run("function f()\n    return 1\n    #return = 2\nend\n", 2), "function f()\n    return 2\nend\n");
	assert.strictEqual(run("function f()\n    #return = 2\n    return 1\nend\n", 1), "function f()\n    return 2\nend\n");
	// A return in the middle is not the end of the function: a new one is added.
	assert.strictEqual(run("function f(a)\n    if a then\n        return 1\n    end\n    #return = 2\nend\n", 4), "function f(a)\n    if a then\n        return 1\n    end\n    return 2\nend\n");
	// The innermost function gets it.
	assert.strictEqual(run("function f()\n    local g = function()\n        #return = 5\n    end\n    return g\nend\n", 2), "function f()\n    local g = function()\n        return 5\n    end\n    return g\nend\n");
	assert.strictEqual(run("#return = 1\nfunction f()\nend\n", 0), null, "outside of a function");
	// The edit is the smallest one.
	assert.deepStrictEqual(rh.minimalEdit("abcdef", "abXef"), { start: 2, end: 4, text: "X" });
	assert.deepStrictEqual(rh.minimalEdit("abc", "abc"), { start: 3, end: 3, text: "" });
	const before = "function f()\n    #return = 2\n    return 1\nend\n";
	const after = rh.applyDirective(before, { line: 1, expr: "2" }, "    ", "\n");
	const e = rh.minimalEdit(before, after);
	assert.strictEqual(before.slice(0, e.start) + e.text + before.slice(e.end), after);
});

test("returnHelper: the settings, the texts and the tab of the panel", function ()
{
	const settingsModel = require("../src/settingsModel");
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const nls = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.json"), "utf8"));
	const nlsRu = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.ru.json"), "utf8"));
	const props = pkg.contributes.configuration.properties;
	const expected = { removeReturnWhenTypeMissing: true, moveCursorToReturnOnIdle: true, idleDelayMs: 2000, enableReturnDirective: true };
	for (const [k, def] of Object.entries(expected))
	{
		const key = "plua.returnHelper." + k;
		assert.ok(props[key] && props[key].default === def, key);
		assert.strictEqual(settingsModel.tabOf(key), "returnHelper", key);
		const text = props[key].markdownDescription.replace(/^%|%$/g, "");
		assert.ok(nls[text] && nlsRu[text], "texts of " + key);
	}
	assert.strictEqual(settingsModel.tabOf("plua.format.autoReturn"), "returnHelper");
	assert.strictEqual(settingsModel.tabOf("plua.diagnostics.returnHint"), "returnHelper");
	assert.strictEqual(settingsModel.kindOf("plua.returnHelper.idleDelayMs", props["plua.returnHelper.idleDelayMs"]), "number");
	assert.strictEqual(settingsModel.validateChange(pkg, "plua.returnHelper.idleDelayMs", 100).ok, false, "below the minimum");
	assert.strictEqual(settingsModel.validateChange(pkg, "plua.returnHelper.idleDelayMs", "3000").value, 3000);
	assert.strictEqual(settingsModel.validateChange(pkg, "plua.returnHelper.idleDelayMs", 2000).isDefault, true);
	const i18n = require("../src/i18n");
	assert.notStrictEqual(i18n.t("settings.tab.returnHelper"), "settings.tab.returnHelper");
	// The idle move and the directive are in the editor module; the undo steps are those of the editor's own edits.
	const { readOptions } = require("../src/returnHintEditor");
	assert.strictEqual(typeof readOptions, "function");
});

const LD_TEXT = [
	"class Car",
	"    function move(speed: float = 1.0, other)",
	"        local acc = 2",
	"        self.hp = 10",
	"        local big = { a = 1, b = 2, c = 3, d = 4, e = 5, f = 6, g = 7, h = 8, i = 9 }",
	"        #speed >show_up",
	"        acc = acc + speed",
	"        self.hp -= 1",
	"        return acc",
	"    end",
	"end",
	"",
].join("\n");
const LD_LINE = 5;

test("liveDirectives: the lines are told from comments and from code", function ()
{
	const ld = require("../src/liveDirectives");
	assert.deepStrictEqual(ld.parseDirective("  -- #self.hp >show_down"), { indent: "  ", comment: true, target: "self.hp", op: "show_down", expr: "" });
	assert.deepStrictEqual(ld.parseDirective("#return = x > 1"), { indent: "", comment: false, target: "return", op: "=", expr: "x > 1" });
	assert.deepStrictEqual(ld.parseDirective("\t#speed=2.5"), { indent: "\t", comment: false, target: "speed", op: "=", expr: "2.5" });
	assert.deepStrictEqual(ld.parseDirective("#self . hp = 1"), { indent: "", comment: false, target: "self.hp", op: "=", expr: "1" });
	assert.strictEqual(ld.parseDirective("#x >").op, ">", "a command not finished");
	assert.strictEqual(ld.parseDirective("#x").op, null, "a bare name");
	assert.strictEqual(ld.parseDirective("#x =").expr, "");
	for (const line of ["-- #TODO fix this", "x = #items", "-- #1 first", "#speed == 2", "local a = 1", "print(\"#a = 1\")", "-- comment"])
	{
		assert.strictEqual(ld.parseDirective(line), null, line);
	}
	assert.strictEqual(ld.isActive(ld.parseDirective("#x =")), false);
	assert.strictEqual(ld.isActive(ld.parseDirective("#x = 1")), true);
	assert.strictEqual(ld.isActive(ld.parseDirective("-- #x >show_up")), true);
	assert.strictEqual(ld.isActive(ld.parseDirective("#x >")), false);
});

test("liveDirectives: show_up and show_down find the declaration, the assignment, the use and the return", function ()
{
	const ld = require("../src/liveDirectives");
	const up = (target) => ld.findAbove(LD_TEXT, LD_LINE, target);
	const down = (target) => ld.findBelow(LD_TEXT, LD_LINE, target);
	assert.deepStrictEqual([up("acc").line, up("acc").kind, up("acc").value, up("acc").type], [2, "declaration", "2", "int"]);
	assert.deepStrictEqual([up("self.hp").line, up("self.hp").kind, up("self.hp").value], [3, "assignment", "10"]);
	assert.deepStrictEqual([up("speed").line, up("speed").kind, up("speed").value, up("speed").type], [1, "parameter", "1.0", "float"]);
	assert.deepStrictEqual([up("other").line, up("other").kind, up("other").value], [1, "parameter", ""]);
	assert.strictEqual(up("big").type, "table");
	assert.strictEqual(up("nothing"), null);
	assert.strictEqual(up("return"), null, "no return above the line");
	assert.deepStrictEqual([down("acc").line, down("acc").kind], [6, "assignment"]);
	assert.deepStrictEqual([down("self.hp").line, down("self.hp").kind, down("self.hp").value], [7, "assignment", "1"]);
	assert.deepStrictEqual([down("speed").line, down("speed").kind], [6, "use"]);
	assert.deepStrictEqual([down("return").line, down("return").value], [8, "acc"]);
	assert.deepStrictEqual([down("other").line, down("other").kind], [8, "return"], "nothing uses it: the final return");
	// A directive line is not a place, a comment form is looked past too.
	assert.strictEqual(ld.findAbove("local a = 1\n#a = 5\n#a >show_up", 2, "a").line, 0);
	// The search is as far as the limit.
	assert.strictEqual(ld.findAbove(LD_TEXT, LD_LINE, "acc", { maxSearchDistance: 2 }), null);
	assert.strictEqual(ld.findAbove(LD_TEXT, LD_LINE, "acc", { maxSearchDistance: 3 }).line, 2);
	// The return of an inner function is not the outer one's.
	const inner = "function f()\n    local g = function()\n        return 1\n    end\n    #return >show_up\n    return 2\nend";
	assert.strictEqual(ld.findAbove(inner, 4, "return"), null);
	assert.strictEqual(ld.findBelow(inner, 4, "return").value, "2");
});

test("liveDirectives: #target = value changes the target, in a function, a field, a parameter and the return", function ()
{
	const ld = require("../src/liveDirectives");
	const at = (target, expr) => { const text = LD_TEXT.replace("#speed >show_up", "#" + target + " = " + expr); return ld.assign(text, LD_LINE, ld.parseDirective("#" + target + " = " + expr), "    ", "\n"); };
	const lines = (text) => text.split("\n");
	assert.strictEqual(lines(at("acc", "99"))[2], "        local acc = 99");
	assert.strictEqual(lines(at("acc", "99")).length, lines(LD_TEXT).length - 1, "the directive line goes");
	assert.strictEqual(lines(at("self.hp", "100"))[3], "        self.hp = 100");
	assert.strictEqual(lines(at("speed", "2.5"))[1], "    function move(speed: float = 2.5, other)");
	assert.strictEqual(lines(at("other", "7"))[1], "    function move(speed: float = 1.0, other = 7)", "a parameter without a default gets one");
	assert.strictEqual(lines(at("big", "{}"))[4], "        local big = {}");
	assert.strictEqual(at("nothing", "1"), null, "a target that is not there");
	// return: the last return at the end takes it in, or a new one is made
	assert.strictEqual(lines(at("return", "acc * 2"))[7], "        return acc * 2");
	assert.strictEqual(ld.assign("function f()\n    local a = 1\n    #return = a\nend", 2, ld.parseDirective("    #return = a"), "    ", "\n"), "function f()\n    local a = 1\n    return a\nend");
	assert.strictEqual(ld.assign("#return = 1", 0, ld.parseDirective("#return = 1"), "    ", "\n"), null, "no function around");
	// The type annotation and the modifiers stay.
	assert.strictEqual(ld.assign("local x: int = 1\n#x = 5", 1, ld.parseDirective("#x = 5"), "    ", "\n"), "local x: int = 5");
	assert.strictEqual(ld.assign("x = 1\nx += 2\n#x = 5", 2, ld.parseDirective("#x = 5"), "    ", "\n"), "x = 1\nx += 5");
	// The comment form is the same line.
	assert.strictEqual(ld.assign("local x = 1\n-- #x = 5", 1, ld.parseDirective("-- #x = 5"), "    ", "\n"), "local x = 5");
});

test("liveDirectives: the grey note is cut, the hover has only the lines asked for", function ()
{
	const ld = require("../src/liveDirectives");
	const { t } = require("../src/i18n");
	assert.strictEqual(ld.truncate("short", 60), "short");
	assert.strictEqual(ld.truncate("a   b\tc", 60), "a b c", "white space is one space");
	assert.strictEqual(ld.truncate("x".repeat(80), 10), "xxxxxxxxx…");
	assert.strictEqual(ld.truncate("x".repeat(10), 10), "xxxxxxxxxx");
	const dir = (s) => ld.parseDirective(s);
	// The default limit of the note is 60 characters; the whole code is in the hover.
	const long = ld.previewFor(LD_TEXT, LD_LINE, dir("#big >show_up"), {});
	assert.strictEqual(long.preview, t("liveDir.above", ld.truncate("local big = { a = 1, b = 2, c = 3, d = 4, e = 5, f = 6, g = 7, h = 8, i = 9 }", 60), 5, t("liveDir.typeSuffix", "table")));
	assert.ok(long.preview.includes("…"));
	assert.ok(ld.previewFor(LD_TEXT, LD_LINE, dir("#big >show_up"), { maxPreviewLength: 200 }).preview.includes("i = 9 }"), "the limit is a setting");
	assert.strictEqual(long.context.lines.length, 3, "the default is 3 lines of context");
	assert.deepStrictEqual([long.context.start, long.context.found], [3, 4], "one line before the found one, and one after it");
	assert.strictEqual(ld.previewFor(LD_TEXT, LD_LINE, dir("#big >show_up"), { maxContextLines: 1 }).context.lines.length, 1);
	assert.strictEqual(ld.previewFor(LD_TEXT, LD_LINE, dir("#big >show_up"), { maxContextLines: 5 }).context.lines.length, 5);
	assert.strictEqual(ld.previewFor(LD_TEXT, LD_LINE, dir("#acc >show_down"), {}).preview, t("liveDir.below", "acc = acc + speed", 7, ""));
	assert.strictEqual(ld.previewFor(LD_TEXT, LD_LINE, dir("#nothing >show_up"), { maxSearchDistance: 50 }).preview, t("liveDir.notFound", "nothing", 50));
	assert.strictEqual(ld.previewFor(LD_TEXT, LD_LINE, dir("#acc = 5"), {}).preview, t("liveDir.replace", "local acc = 5", 3));
	assert.strictEqual(ld.previewFor(LD_TEXT, LD_LINE, dir("#acc ="), {}).preview, t("liveDir.current", "local acc = 2", 3));
	assert.strictEqual(ld.previewFor(LD_TEXT, LD_LINE, dir("#speed = 2.5"), {}).preview, t("liveDir.replace", "function move(speed: float = 2.5, other)", 2));
	assert.strictEqual(ld.previewFor("function f()\n    #return = 1\nend", 1, dir("#return = 1"), {}).preview, t("liveDir.createReturn", "1"));
	assert.strictEqual(ld.previewFor("function f()\n    return 0\n    #return = 1\nend", 2, dir("#return = 1"), {}).preview, t("liveDir.replaceReturn", "return 1", 2));
	assert.strictEqual(ld.previewFor("#return = 1", 0, dir("#return = 1"), {}).preview, t("liveDir.noFunction"));
	assert.strictEqual(ld.previewFor(LD_TEXT, LD_LINE, dir("#x >"), {}), null, "a command that is not finished shows nothing");
	// Comments in the code or after it do not confuse the search.
	assert.strictEqual(ld.findAbove("local a = 1 -- a = 5\n#a >show_up", 1, "a").value, "1");
});

test("liveDirectives: completion after # and after the target", function ()
{
	const ld = require("../src/liveDirectives");
	const labels = (text, line, col, o) => ld.completionsFor(text, line, col, o).map(i => i.label);
	const kinds = (text, line, col) => Object.fromEntries(ld.completionsFor(text, line, col).map(i => [i.label, i.kind]));
	const before = LD_TEXT.replace("        #speed >show_up", "        #");
	const col = "        #".length;
	assert.deepStrictEqual(labels(before, LD_LINE, col), ["return", "speed", "other", "big", "acc", "self.hp"]);
	const all = kinds(before, LD_LINE, col);
	assert.deepStrictEqual([all["return"], all["speed"], all["other"], all["acc"], all["self.hp"], all["big"]], ["keyword", "parameter", "parameter", "variable", "field", "variable"]);
	assert.strictEqual(labels(before, LD_LINE, col)[0], "return", "return comes first");
	// In a comment, with a word begun, and with spaces after the `#`.
	assert.ok(labels("function f(a)\n    -- #\nend", 1, 8).includes("a"));
	assert.ok(labels("function f(a)\n    # a\nend", 1, 7).includes("a"));
	assert.ok(labels("function f(a)\n    #se\nend", 1, 7).includes("return"));
	// After `>`: the commands, with their texts.
	const cmd = ld.completionsFor("#acc >", 0, 6);
	assert.deepStrictEqual(cmd.map(i => i.label), ld.COMMANDS);
	assert.ok(cmd.every(i => i.detail && i.documentation));
	assert.deepStrictEqual(labels("-- #return >sh", 0, 14), ld.COMMANDS);
	assert.deepStrictEqual(labels("#self.hp > ", 0, 11), ld.COMMANDS);
	// Not on other lines.
	assert.deepStrictEqual(labels("local x = #items", 0, 16), []);
	assert.deepStrictEqual(labels("print(1) -- #", 0, 13), []);
	// Locals below the line or out of the search are not offered.
	assert.ok(!labels("function f()\n    #\n    local later = 1\nend", 1, 5).includes("later"));
	assert.ok(!labels("local far = 1\n\n\n\n#", 4, 1, { maxSearchDistance: 3 }).includes("far"));
	assert.ok(labels("local far = 1\n\n\n\n#", 4, 1, { maxSearchDistance: 4 }).includes("far"));
	assert.ok(labels("for i = 1, 3 do\n    #\nend", 1, 5).includes("i"), "loop variables");
	assert.ok(labels("function f()\nend\nfunction g()\n    self.name = 1\n    #\nend", 4, 5).includes("self.name"));
});

test("liveDirectives: settings, texts, the Escape key and the old directive of the return helper", function ()
{
	const settingsModel = require("../src/settingsModel");
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const nls = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.json"), "utf8"));
	const nlsRu = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.ru.json"), "utf8"));
	const props = pkg.contributes.configuration.properties;
	const expected = { enabled: true, maxPreviewLength: 60, maxContextLines: 3, maxSearchDistance: 200, completion: true, inComments: true };
	for (const [k, def] of Object.entries(expected))
	{
		const key = "plua.liveDirectives." + k;
		assert.ok(props[key] && props[key].default === def, key);
		assert.strictEqual(settingsModel.tabOf(key), "liveDirectives", key);
		const text = props[key].markdownDescription.replace(/^%|%$/g, "");
		assert.ok(nls[text] && nlsRu[text], "texts of " + key);
	}
	assert.strictEqual(settingsModel.kindOf("plua.liveDirectives.maxPreviewLength", props["plua.liveDirectives.maxPreviewLength"]), "number");
	assert.strictEqual(settingsModel.validateChange(pkg, "plua.liveDirectives.maxContextLines", 0).ok, false);
	assert.strictEqual(settingsModel.validateChange(pkg, "plua.liveDirectives.maxSearchDistance", 300).value, 300);
	const i18n = require("../src/i18n");
	for (const key of ["settings.tab.liveDirectives", "liveDir.above", "liveDir.below", "liveDir.notFound", "liveDir.replace", "liveDir.cmd.show_up", "liveDir.cmdDoc.show_down", "liveDir.item.field"])
	{
		assert.notStrictEqual(i18n.t(key), key, key);
	}
	const escape = pkg.contributes.keybindings.find(k => k.command == "plua.liveDirectives.dismiss");
	assert.ok(escape && escape.key == "escape" && /plua\.onDirectiveLine/.test(escape.when) && /!suggestWidgetVisible/.test(escape.when));
	// `#return = x` is no return statement of the function: the helpers of the return do not count it.
	const { findFunctionShapes } = require("../src/hints");
	const shape = findFunctionShapes("function f()\n    #return = 1\nend")[0];
	assert.deepStrictEqual([shape.returns.length, shape.bodyEmpty], [0, false]);
	assert.deepStrictEqual(shape.params, []);
	assert.deepStrictEqual(findFunctionShapes("function f(a: int, b = g(1), c)\nend")[0].params.map(p => p.name), ["a", "b", "c"]);
});

test("idleController: the timer stands still while suggestions or parameter hints are open", function ()
{
	const { createIdleController } = require("../src/idleController");
	let now = 0;
	let nextId = 1;
	const timers = new Map();
	const fake = {
		setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
		clearTimeout: (id) => { timers.delete(id); },
	};
	const advance = (ms) =>
	{
		const end = now + ms;
		for (;;)
		{
			const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due)
			{
				break;
			}
			now = due[1].at;
			timers.delete(due[0]);
			due[1].fn();
		}
		now = end;
	};
	const fired = [];
	const contexts = [];
	const ctl = createIdleController({ delay: () => 2000, onFire: (d) => fired.push(d), onContext: (a) => contexts.push(a), ...fake, holdFallbackMs: 20000 });
	// Without suggestions it fires after the delay.
	ctl.arm("line1");
	advance(1999);
	assert.deepStrictEqual(fired, []);
	advance(2);
	assert.deepStrictEqual(fired, ["line1"]);
	assert.strictEqual(ctl.armed, false);
	assert.deepStrictEqual(contexts, [true, false], "the context key follows the timer");
	// Ctrl+Space: the timer is off and reset, however long the list stays open.
	fired.length = 0;
	ctl.arm("line2");
	advance(1500);
	ctl.hold();
	assert.strictEqual(ctl.held, true);
	advance(10000);
	assert.deepStrictEqual(fired, [], "held");
	// Moving in the list (Down, Up, PageDown, PageUp, the parameter hints) keeps it held and does not start it.
	for (let i = 0; i < 4; ++i)
	{
		ctl.hold();
		advance(1000);
	}
	ctl.touch();
	advance(5000);
	assert.deepStrictEqual(fired, [], "a sign of life does not start it while the list is open");
	// The list is closed: it counts again from the start of the delay, not from where it was.
	ctl.release();
	assert.strictEqual(ctl.held, false);
	advance(1999);
	assert.deepStrictEqual(fired, []);
	advance(2);
	assert.deepStrictEqual(fired, ["line2"]);
	// Release without a hold, or after the end, is nothing; cancel clears everything.
	ctl.release();
	ctl.hold();
	assert.strictEqual(ctl.armed, false);
	fired.length = 0;
	ctl.arm("line3");
	ctl.hold();
	ctl.cancel();
	advance(60000);
	assert.deepStrictEqual(fired, []);
	assert.strictEqual(timers.size, 0, "no timer is left");
	// A safety net: a list closed in a way nobody saw (a click) does not hold the timer for ever.
	ctl.arm("line4");
	ctl.hold();
	advance(19999);
	assert.deepStrictEqual(fired, []);
	advance(1);
	advance(2000);
	assert.deepStrictEqual(fired, ["line4"]);
	// Arming again restarts everything, also out of a hold.
	fired.length = 0;
	ctl.arm("a");
	ctl.hold();
	ctl.arm("b");
	assert.strictEqual(ctl.held, false);
	advance(2000);
	assert.deepStrictEqual(fired, ["b"]);
	// The keys that hold and release the timer are bound, only while it is armed.
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const idleKeys = pkg.contributes.keybindings.filter(k => k.command == "plua.idle.key");
	const byCommand = (c) => idleKeys.filter(k => k.args[0] == c);
	for (const [command, mode] of [["editor.action.triggerSuggest", "hold"], ["editor.action.triggerParameterHints", "hold"], ["selectNextSuggestion", "hold"], ["selectPrevSuggestion", "hold"],
		["selectNextPageSuggestion", "hold"], ["selectPrevPageSuggestion", "hold"], ["showNextParameterHint", "hold"], ["showPrevParameterHint", "hold"],
		["hideSuggestWidget", "release"], ["acceptSelectedSuggestion", "release"], ["closeParameterHints", "release"]])
	{
		assert.ok(byCommand(command).length >= 1 && byCommand(command).every(k => k.args[1] == mode && /plua\.idleArmed/.test(k.when)), command);
	}
	assert.ok(byCommand("acceptSelectedSuggestion").length == 2, "Enter and Tab");
	assert.ok(idleKeys.filter(k => /parameterHintsVisible/.test(k.when)).length == 3);
});

test("liveDirectives: the prefix, the separator and the aliases are settings that work at once", function ()
{
	const ld = require("../src/liveDirectives");
	const at = { prefix: "@", commandSeparator: "::", commandAliases: { up: "show_up", down: "show_down" } };
	assert.deepStrictEqual(ld.parseDirective("  @speed::up", at), { indent: "  ", comment: false, target: "speed", op: "show_up", expr: "" });
	assert.deepStrictEqual(ld.parseDirective("-- @self.hp :: down", at), { indent: "", comment: true, target: "self.hp", op: "show_down", expr: "" });
	assert.strictEqual(ld.parseDirective("@speed::show_down", at).op, "show_down", "the first names still work");
	assert.strictEqual(ld.parseDirective("@speed = 2", at).expr, "2");
	assert.strictEqual(ld.parseDirective("#speed = 2", at), null, "the old prefix is code now");
	assert.strictEqual(ld.parseDirective("@speed >show_up", at), null, "the old separator is not one");
	assert.strictEqual(ld.parseDirective("@speed::sideways", at).op, ">", "an unknown command is not carried out");
	assert.strictEqual(ld.parseDirective("#speed >up", { commandAliases: { up: "show_up" } }).op, "show_up");
	assert.strictEqual(ld.parseDirective("#speed >up").op, ">", "no alias by default");
	assert.strictEqual(ld.parseDirective("$$x->show_up", { prefix: "$$", commandSeparator: "->" }).op, "show_up");
	assert.strictEqual(ld.parseDirective("#x > show_up", { prefix: "", commandSeparator: " " }).op, "show_up", "a prefix that cannot be used is the default");
	assert.deepStrictEqual(ld.syntaxOf({ commandAliases: { up: "show_up", bad: "rm", "no good": "show_down" } }).aliases, { up: "show_up" }, "only names of letters, to a real command");
	// Search, preview, assignment and completion follow the syntax.
	const text = "function f(speed)\n    local acc = 2\n    @acc::up\n    return acc\nend";
	assert.strictEqual(ld.previewFor(text, 2, ld.parseDirective("    @acc::up", at), at).found.line, 1);
	assert.strictEqual(ld.findAbove("local a = 1\n@a = 5\n@a::up", 2, "a", at).line, 0, "a directive line in the new syntax is not a place");
	assert.strictEqual(ld.assign("local a = 1\n@a = 5", 1, ld.parseDirective("@a = 5", at), "    ", "\n", at), "local a = 5");
	const names = (line, col, o) => ld.completionsFor("function f(speed)\n" + line + "\nend", 1, col, o).map(i => i.label);
	assert.ok(names("@", 1, at).includes("speed") && names("@", 1, at).includes("return"));
	assert.deepStrictEqual(names("#", 1, at), [], "not after the old prefix");
	assert.deepStrictEqual(names("@speed ::", 9, at), ld.COMMANDS.concat(["up", "down"]), "the aliases are offered too");
	assert.deepStrictEqual(names("@speed >", 8, at), []);
	assert.deepStrictEqual(names("-- @sp", 6, at).includes("speed"), true);
	// A prefix with signs that mean something in a pattern.
	assert.strictEqual(ld.parseDirective("$x.y = 1", { prefix: "$" }).target, "x.y");
	assert.strictEqual(ld.parseDirective("*x = 1", { prefix: "*" }).expr, "1");
	assert.strictEqual(ld.parseDirective("%x::show_up", { prefix: "%", commandSeparator: "::" }).op, "show_up");
});

test("liveDirectives: the limits of the directives (constants, read-only, ignored names)", function ()
{
	const ld = require("../src/liveDirectives");
	const { t } = require("../src/i18n");
	const text = "function f(speed)\n    local acc = 2\n    local k <const> = 5\n    const c2 = 7\n    local m <close> = nil\n    self._cache = 1\n    #X\n    return acc\nend";
	const line = 6;
	const run = (target, expr, o) => ld.assignResult(text.replace("#X", "#" + target + " = " + expr), line, { target, op: "=", expr }, "    ", "\n", o);
	// A constant is found (it used to be skipped, and an older assignment was changed instead) and left alone.
	assert.strictEqual(ld.findAbove(text, line, "k").constant, true);
	assert.strictEqual(ld.findAbove(text, line, "k").value, "5");
	assert.strictEqual(ld.findAbove(text, line, "c2").constant, true);
	assert.strictEqual(ld.findAbove(text, line, "acc").constant, false);
	assert.deepStrictEqual([run("k", "9").reason, run("k", "9").text], ["const", null]);
	assert.strictEqual(run("c2", "9").reason, "const");
	assert.strictEqual(run("k", "9", { skipConst: false }).text.split("\n")[2], "    local k <const> = 9", "skipConst off: it is changed");
	assert.strictEqual(run("m", "1").reason, "ok", "<close> is no constant");
	assert.strictEqual(run("acc", "9").text.split("\n")[1], "    local acc = 9");
	// Read-only: the changing goes, looking stays.
	assert.deepStrictEqual([run("acc", "9", { allowModify: false }).reason, run("acc", "9", { allowModify: false }).text], ["readOnly", null]);
	assert.strictEqual(ld.findAbove(text, line, "acc", { allowModify: false }).line, 1);
	assert.strictEqual(ld.previewFor(text, line, { target: "acc", op: "=", expr: "5" }, { allowModify: false }).preview, t("liveDir.readOnly"));
	assert.ok(ld.previewFor(text, line, { target: "acc", op: "show_up", expr: "" }, { allowModify: false }).preview.includes("local acc = 2"));
	// The note of a constant.
	assert.strictEqual(ld.previewFor(text, line, { target: "k", op: "=", expr: "9" }, {}).preview, t("liveDir.const", "k", 3));
	assert.ok(ld.previewFor(text, line, { target: "k", op: "=", expr: "9" }, { skipConst: false }).preview.includes("<const> = 9"));
	// Ignored names, with a pattern.
	assert.strictEqual(ld.isIgnored("acc", ["acc"]), true);
	assert.strictEqual(ld.isIgnored("self._cache", ["self._*"]), true);
	assert.strictEqual(ld.isIgnored("self.cache", ["self._*"]), false);
	assert.strictEqual(ld.isIgnored("acc2", ["acc"]), false);
	assert.strictEqual(ld.isIgnored("x", ["", "  ", 5]), false);
	assert.strictEqual(ld.isIgnored("x", undefined), false);
	assert.strictEqual(run("acc", "9", { ignoredTargets: ["acc"] }).reason, "ignored");
	assert.strictEqual(run("self._cache", "9", { ignoredTargets: ["self._*"] }).reason, "ignored");
	assert.strictEqual(run("return", "1", { ignoredTargets: ["return"] }).reason, "ignored");
	assert.strictEqual(ld.previewFor(text, line, { target: "acc", op: "show_up", expr: "" }, { ignoredTargets: ["acc"] }), null);
	assert.ok(!ld.completionsFor(text.replace("#X", "#"), line, 5, { ignoredTargets: ["acc", "self._*", "return"] }).map(i => i.label).some(l => ["acc", "self._cache", "return"].includes(l)));
	assert.ok(ld.completionsFor(text.replace("#X", "#"), line, 5, {}).map(i => i.label).includes("self._cache"));
	assert.strictEqual(run("zzz", "1").reason, "notFound");
	assert.strictEqual(ld.assign(text.replace("#X", "#acc = 9"), line, { target: "acc", op: "=", expr: "9" }, "    ", "\n", {}).split("\n")[1], "    local acc = 9");
});

test("liveDirectives: the new settings, their checks and their texts", function ()
{
	const settingsModel = require("../src/settingsModel");
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const nls = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.json"), "utf8"));
	const nlsRu = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.nls.ru.json"), "utf8"));
	const props = pkg.contributes.configuration.properties;
	const expected = { allowModify: true, skipConst: true, prefix: "#", commandSeparator: ">" };
	for (const [k, def] of Object.entries(expected))
	{
		assert.strictEqual(props["plua.liveDirectives." + k].default, def, k);
	}
	assert.deepStrictEqual([props["plua.liveDirectives.ignoredTargets"].default, props["plua.liveDirectives.commandAliases"].default], [[], {}]);
	for (const k of ["allowModify", "skipConst", "ignoredTargets", "prefix", "commandSeparator", "commandAliases"])
	{
		const key = "plua.liveDirectives." + k;
		assert.strictEqual(settingsModel.tabOf(key), "liveDirectives", key);
		const text = props[key].markdownDescription.replace(/^%|%$/g, "");
		assert.ok(nls[text] && nlsRu[text], "texts of " + key);
	}
	assert.strictEqual(settingsModel.kindOf("plua.liveDirectives.ignoredTargets", props["plua.liveDirectives.ignoredTargets"]), "list");
	assert.strictEqual(settingsModel.kindOf("plua.liveDirectives.allowModify", props["plua.liveDirectives.allowModify"]), "boolean");
	assert.strictEqual(settingsModel.kindOf("plua.liveDirectives.prefix", props["plua.liveDirectives.prefix"]), "text");
	const ok = (key, value) => settingsModel.validateChange(pkg, key, value);
	assert.strictEqual(ok("plua.liveDirectives.prefix", "@").value, "@");
	assert.strictEqual(ok("plua.liveDirectives.prefix", "$$").ok, true);
	assert.strictEqual(ok("plua.liveDirectives.prefix", "#").isDefault, true);
	for (const bad of ["", "a b", "abcd", 5])
	{
		assert.strictEqual(ok("plua.liveDirectives.prefix", bad).ok, false, "prefix " + bad);
	}
	assert.strictEqual(ok("plua.liveDirectives.commandSeparator", "::").ok, true);
	assert.strictEqual(ok("plua.liveDirectives.commandSeparator", "->").ok, true);
	for (const bad of ["", "a", ">>>>>", " ", ": :", "x>"])
	{
		assert.strictEqual(ok("plua.liveDirectives.commandSeparator", bad).ok, false, "separator " + bad);
	}
	assert.strictEqual(ok("plua.liveDirectives.commandAliases", { up: "show_up", down: "show_down" }).ok, true);
	assert.strictEqual(ok("plua.liveDirectives.commandAliases", {}).isDefault, true);
	for (const bad of [{ up: "rm" }, { "u p": "show_up" }, [], "up", null, { up: 1 }])
	{
		assert.strictEqual(ok("plua.liveDirectives.commandAliases", bad).ok, false, JSON.stringify(bad));
	}
	assert.deepStrictEqual(ok("plua.liveDirectives.ignoredTargets", [" acc ", "", "self._*"]).value, ["acc", "self._*"]);
	assert.strictEqual(ok("plua.liveDirectives.allowModify", "no").ok, false);
	const i18n = require("../src/i18n");
	for (const key of ["liveDir.const", "liveDir.readOnly", "settings.err.prefix", "settings.err.separator", "settings.err.aliases"])
	{
		assert.notStrictEqual(i18n.t(key), key, key);
	}
	// A `return` that follows the prefix is a directive, not a statement, whatever the prefix is.
	const { findFunctionShapes, setDirectivePrefix } = require("../src/hints");
	try
	{
		setDirectivePrefix("@");
		assert.strictEqual(findFunctionShapes("function f()\n    @return = 1\nend")[0].returns.length, 0);
		assert.strictEqual(findFunctionShapes("function f()\n    #return = 1\nend")[0].returns.length, 1, "# is a plain token now");
		setDirectivePrefix("#");
		assert.strictEqual(findFunctionShapes("function f()\n    #return = 1\nend")[0].returns.length, 0);
		setDirectivePrefix("");
		assert.strictEqual(findFunctionShapes("function f()\n    #return = 1\nend")[0].returns.length, 0, "an unusable prefix is the default");
	}
	finally
	{
		setDirectivePrefix("#");
	}
});

test("returnHelper bugs: a mistyped type behind the ) and an erased value both leave a bare return that goes", function ()
{
	const rh = require("../src/returnHint");
	const { findFunctionShapes } = require("../src/hints");
	const known = (name) => ["int", "bool", "string", "Car"].includes(name);
	const keys = (text) => rh.emptyReturnsWithoutType(findFunctionShapes(text), known);
	// Bug 1: `function test() boo`, a name where the type should be (no colon): it used to count as code of the body.
	const shape = findFunctionShapes("function test() boo\n\treturn\nend")[0];
	assert.deepStrictEqual([shape.stray, shape.hasColon, shape.retType, shape.onlyBareReturn], ["boo", false, null, true]);
	assert.deepStrictEqual(keys("function test() boo\n\treturn\nend"), ["test#1"]);
	assert.deepStrictEqual(keys("function test(a, b) boo\n\t\n\treturn \nend"), ["test#1"]);
	assert.deepStrictEqual(keys("function test(): boo\n\treturn\nend"), ["test#1"], "the same with a colon");
	assert.deepStrictEqual(keys("function test(): b\n\treturn\nend"), ["test#1"], "an unfinished type");
	assert.deepStrictEqual(keys("function test() boo\n\treturn 1\nend"), [], "a return with a value is not touched");
	assert.deepStrictEqual(keys("function test() boo\n\tprint(1)\n\treturn\nend"), [], "other code in the body");
	assert.deepStrictEqual(keys("function test(): bool\n\treturn\nend"), [], "a good type");
	// What is not a mistyped type: code on the same line, a call, an assignment, a keyword.
	for (const text of ["function f() return 1 end", "function f() print(1)\n\treturn\nend", "function f() x = 1\n\treturn\nend", "function f() end"])
	{
		assert.strictEqual(findFunctionShapes(text)[0].stray, null, text);
	}
	// The `)` of the header: where a written type goes.
	const header = "function test(a, b) boo";
	assert.strictEqual(findFunctionShapes(header + "\n\treturn\nend")[0].closeEnd, header.indexOf(")") + 1);
	// Bug 2: the value of a return is erased: the text is the same as one that was never filled in.
	assert.deepStrictEqual(keys("function test()\n\treturn 123\nend"), []);
	assert.deepStrictEqual(keys("function test()\n\treturn \nend"), ["test#1"]);
	assert.deepStrictEqual(keys("function test(): boo\n\treturn \nend"), ["test#1"]);
	assert.deepStrictEqual(keys("function test(): boo\n\treturn 12\nend"), []);
	// An edit inside the return line belongs to the function: its lines run from the `)` to the `end`.
	const s2 = findFunctionShapes("function test()\n\treturn \nend")[0];
	assert.deepStrictEqual([s2.closeLine, s2.endLine, s2.returns[0].line], [0, 2, 1]);
});

test("returnHelper: Ctrl+Z of what erased a value counts as an edit, the undo of the removal itself does not come back", function ()
{
	// The editor part is a set of rules over the module state; they are in the handler of returnHintEditor.
	const source = fs.readFileSync(path.join(__dirname, "..", "src", "returnHintEditor.js"), "utf8");
	assert.ok(/suppressed/.test(source) && /undoing \? \[\] : result\.removeBare/.test(source), "an undo does not use the memory of the old type");
	assert.ok(/state\.suppressed\.add\(key\)/.test(source), "our own removal is remembered");
	assert.ok(/touched\.forEach\(k => state\.suppressed\.delete\(k\)\)/.test(source), "an edit of the user ends the protection");
	assert.ok(/touched\.includes\(k\) && !state\.suppressed\.has\(k\)/.test(source));
});

const LC_TEXT = [
	"class Car",
	"    function move(speed: float = 1.0)",
	"        local acc = 2",
	"        local k = 5",
	"        local tmp = 9",
	"        local total = acc * speed",
	"        self.hp = total + k",
	"        local t = { acc = 1 }",
	"        print(obj.acc, \"acc\") -- acc",
	"        acc = acc + speed",
	"        #X",
	"        if acc > 3 then return acc > 3 end",
	"        return total > 3",
	"    end",
	"    function update()",
	"        self:move(1)",
	"        move(2)",
	"    end",
	"end",
].join("\n");
const LC_LINE = 10;

test("liveDirectives commands: show_all, type, trace and calls look around", function ()
{
	const ld = require("../src/liveDirectives");
	const { t } = require("../src/i18n");
	const at = (d) => LC_TEXT.replace("#X", d);
	const preview = (d, o) => ld.previewFor(at(d), LC_LINE, ld.parseDirective(d, o), o);
	// show_all: the places of the name; a table key and the field of another object are no places.
	const all = ld.findPlaces(at("#acc >show_all"), LC_LINE, "acc");
	assert.deepStrictEqual(all.map(p => [p.line, p.kind]), [[2, "declaration"], [5, "use"], [9, "assignment"], [11, "use"]]);
	assert.strictEqual(preview("#acc >show_all").places.length, 4);
	assert.ok(preview("#acc >show_all").preview.startsWith(t("liveDir.all", 4, "").slice(0, 9)));
	assert.deepStrictEqual(ld.findPlaces(at("#speed >show_all"), LC_LINE, "speed").map(p => [p.line, p.kind]), [[1, "parameter"], [5, "use"], [9, "use"]]);
	assert.deepStrictEqual(ld.findPlaces(at("#return >show_all"), LC_LINE, "return").map(p => p.line), [11, 12]);
	assert.deepStrictEqual(ld.findPlaces(at("#self.hp >show_all"), LC_LINE, "self.hp").map(p => p.line), [6]);
	assert.deepStrictEqual(ld.findPlaces(at("#acc >show_all"), LC_LINE, "acc", { maxSearchDistance: 3 }).map(p => p.line), [9, 11], "the distance is a limit (the declaration is 8 lines up)");
	assert.strictEqual(ld.previewFor(at("#zzz >show_all"), LC_LINE, ld.parseDirective("#zzz >show_all"), {}).preview, t("liveDir.notFound", "zzz", 200));
	// type: the type and its source, the union of the returns
	assert.strictEqual(preview("#acc >type").preview, t("liveDir.type", "int", t("liveDir.typeFrom", "local acc = 2", 3)), "the declaration tells the type when the nearest place does not");
	assert.strictEqual(preview("#speed >type").preview.includes("float"), true);
	assert.strictEqual(preview("#return >type").preview, t("liveDir.type", "bool", t("liveDir.typeReturns", 2, "12, 13")));
	assert.strictEqual(ld.typeInfo("function f(a)\n    if a then return 1 end\n    #X\n    return \"no\"\nend", 2, "return").type, "int|string", "a union");
	assert.strictEqual(ld.typeInfo("function f(a)\n    if a then return 1 end\n    #X\n    return g(a)\nend", 2, "return").type, null, "one return that cannot be told");
	assert.ok(preview("#total >type").preview.startsWith(t("liveDir.typeUnknown", "").slice(0, 10)));
	// trace: up to 3 steps, each from a name the step before is made of
	const steps = ld.traceChain(at("#total >trace"), LC_LINE, "total");
	assert.deepStrictEqual(steps.map(s => [s.name, s.line]), [["total", 5], ["acc", 2]]);
	assert.deepStrictEqual(ld.traceChain("local a = 1\nlocal b = a + 1\nlocal c = b * 2\nlocal d = c - 1\n#d >trace", 4, "d").map(s => s.name), ["d", "c", "b"], "at most 3 steps");
	assert.deepStrictEqual(ld.traceChain("function f(p)\n    local x = p * 2\n    #x >trace\nend", 2, "x").map(s => [s.name, s.kind]), [["x", "declaration"], ["p", "parameter"]]);
	assert.strictEqual(ld.traceChain(at("#return >trace"), LC_LINE, "return")[0].name, "return", "the return is followed too");
	assert.strictEqual(preview("#total >trace").steps.length, 2);
	assert.ok(preview("#total >trace").preview.includes(" ← "));
	assert.strictEqual(preview("#total >trace", { maxPreviewLength: 20 }).preview.length <= 20, true, "cut");
	// calls: with the class and the method they are in
	const calls = ld.findCalls(at("#move >calls"), LC_LINE, "move");
	assert.deepStrictEqual(calls.map(c => [c.line, c.where]), [[15, "Car:update"], [16, "Car:update"]]);
	assert.deepStrictEqual(ld.findCalls(at("#move >calls"), LC_LINE, "move", { maxSearchDistance: 4 }), [], "the distance is a limit");
	assert.strictEqual(preview("#move >calls").preview, t("liveDir.calls", 2, t("liveDir.callShort", 16, "Car:update") + ", " + t("liveDir.callShort", 17, "Car:update")));
	assert.strictEqual(preview("#nothing >calls").preview, t("liveDir.noCalls", "nothing"));
	assert.strictEqual(ld.contextName(LC_TEXT.split("\n"), require("../src/hints").findFunctionShapes(LC_TEXT), 15), "Car:update");
	// The commands in a comment and the limits that all of them respect.
	assert.strictEqual(preview("-- #acc >show_all").places.length, 4);
	assert.strictEqual(preview("#acc >show_all", { ignoredTargets: ["acc"] }), null);
	assert.strictEqual(preview("#acc >type", { ignoredTargets: ["a*"] }), null);
});

test("liveDirectives commands: sign, const, rename and unused change or mark code", function ()
{
	const ld = require("../src/liveDirectives");
	const { t } = require("../src/i18n");
	const at = (d) => LC_TEXT.replace("#X", d);
	const apply = (d, o) => ld.applyDirectiveCommand(at(d), LC_LINE, ld.parseDirective(d, o), "    ", "\n", o || {});
	const row = (r, n) => r.text.split("\n")[n];
	// sign: the type of the returns in the header, the type of a variable at its declaration
	assert.strictEqual(row(apply("#return >sign"), 1), "    function move(speed: float = 1.0): bool");
	assert.strictEqual(apply("#return >sign").text.split("\n").length, LC_TEXT.split("\n").length - 1, "the directive line goes");
	assert.strictEqual(row(apply("#acc >sign"), 2), "        local acc: int = 2");
	assert.strictEqual(apply("#total >sign").reason, "unknown", "the type cannot be told from `acc * speed`");
	assert.strictEqual(ld.applyDirectiveCommand("function f()\n    #X\n    return 1\nend".replace("#X", "#return >sign"), 1, ld.parseDirective("#return >sign"), "    ", "\n").text, "function f(): int\n    return 1\nend");
	assert.strictEqual(ld.applyDirectiveCommand("function f(): string\n    #return >sign\n    return 1\nend", 1, ld.parseDirective("#return >sign"), "    ", "\n").reason, "exists");
	assert.strictEqual(ld.applyDirectiveCommand("local x: int = 1\n#x >sign", 1, ld.parseDirective("#x >sign"), "    ", "\n").reason, "exists");
	assert.strictEqual(ld.applyDirectiveCommand("local x <const> = 1\n#x >sign", 1, ld.parseDirective("#x >sign"), "    ", "\n").text, "local x: int <const> = 1", "the type goes before the attribute");
	assert.strictEqual(ld.applyDirectiveCommand("function f()\n    #return >sign\nend", 1, ld.parseDirective("#return >sign"), "    ", "\n").reason, "noReturn");
	assert.strictEqual(ld.applyDirectiveCommand("#return >sign", 0, ld.parseDirective("#return >sign"), "    ", "\n").reason, "noFunction");
	assert.strictEqual(ld.previewFor(at("#return >sign"), LC_LINE, ld.parseDirective("#return >sign"), {}).preview, t("liveDir.sign", "bool", "function move(speed: float = 1.0): bool"));
	// const: only when nothing sets the name again; the type stays in front
	assert.strictEqual(row(apply("#k >const"), 3), "        local k <const> = 5");
	assert.strictEqual(apply("#acc >const").reason, "changed");
	assert.strictEqual(ld.constPlan(at("#acc >const"), LC_LINE, "acc").line, 9);
	assert.strictEqual(ld.applyDirectiveCommand("local x: int = 1\n#x >const", 1, ld.parseDirective("#x >const"), "    ", "\n").text, "local x: int <const> = 1");
	assert.strictEqual(ld.applyDirectiveCommand("local x <const> = 1\n#x >const", 1, ld.parseDirective("#x >const"), "    ", "\n").reason, "already");
	assert.strictEqual(ld.applyDirectiveCommand("self.x = 1\n#self.x >const", 1, ld.parseDirective("#self.x >const"), "    ", "\n").reason, "badTarget");
	assert.strictEqual(ld.previewFor(at("#k >const"), LC_LINE, ld.parseDirective("#k >const"), {}).preview, t("liveDir.constAdd", "local k <const> = 5"));
	assert.strictEqual(ld.previewFor(at("#acc >const"), LC_LINE, ld.parseDirective("#acc >const"), {}).preview, t("liveDir.const.changed", "acc", 10));
	// rename: in the function, not in strings, comments, table keys or the fields of other objects
	const renamed = apply("#acc >rename = sum");
	assert.deepStrictEqual([2, 5, 7, 8, 9, 10].map(n => row(renamed, n)), [
		"        local sum = 2", "        local total = sum * speed", "        local t = { acc = 1 }", "        print(obj.acc, \"acc\") -- acc",
		"        sum = sum + speed", "        if sum > 3 then return sum > 3 end"]);
	assert.strictEqual(ld.renamePlan(at("#acc >rename = sum"), LC_LINE, "acc", "sum").count, 6);
	assert.strictEqual(ld.renamePlan(at("#acc >rename = k"), LC_LINE, "acc", "k").reason, "taken");
	assert.strictEqual(ld.renamePlan(at("#acc >rename = 9x"), LC_LINE, "acc", "9x").reason, "badName");
	assert.strictEqual(ld.renamePlan(at("#acc >rename = end"), LC_LINE, "acc", "end").reason, "badName");
	assert.strictEqual(ld.renamePlan(at("#acc >rename"), LC_LINE, "acc", "").reason, "needName");
	assert.strictEqual(ld.renamePlan(at("#return >rename = x"), LC_LINE, "return", "x").reason, "badTarget");
	assert.strictEqual(ld.renamePlan(at("#zzz >rename = x"), LC_LINE, "zzz", "x").reason, "notFound");
	assert.strictEqual(row(apply("#self.hp >rename = life"), 6), "        self.life = total + k", "a field: in the file");
	assert.strictEqual(row(apply("#self.hp >rename = self.life"), 6), "        self.life = total + k");
	assert.strictEqual(ld.renamePlan("function a()\n    local x = 1\n    #x >rename = y\nend\nfunction b()\n    local x = 2\nend", 2, "x", "y").text, "function a()\n    local y = 1\nend\nfunction b()\n    local x = 2\nend", "only the function around");
	assert.strictEqual(ld.renamePlan("function a(p)\n    #p >rename = q\n    return p + 1\nend", 1, "p", "q").text, "function a(q)\n    return q + 1\nend", "a parameter");
	// The limits: a constant, read-only, ignored names; the commands that only look are never carried out
	assert.strictEqual(apply("#acc >rename = sum", { allowModify: false }).reason, "readOnly");
	assert.strictEqual(apply("#acc >sign", { allowModify: false }).reason, "readOnly");
	assert.strictEqual(apply("#k >const", { ignoredTargets: ["k"] }).reason, "ignored");
	assert.strictEqual(ld.applyDirectiveCommand("local c <const> = 1\n#c >rename = d", 1, ld.parseDirective("#c >rename = d"), "    ", "\n").reason, "const");
	assert.strictEqual(ld.applyDirectiveCommand("local c <const> = 1\n#c >rename = d", 1, ld.parseDirective("#c >rename = d"), "    ", "\n", { skipConst: false }).reason, "ok");
	assert.strictEqual(apply("#acc >show_all").reason, "view");
	assert.strictEqual(ld.previewFor(at("#acc >sign"), LC_LINE, ld.parseDirective("#acc >sign"), { allowModify: false }).preview, t("liveDir.readOnly"));
	assert.strictEqual(ld.previewFor(at("#acc >rename = sum"), LC_LINE, ld.parseDirective("#acc >rename = sum"), {}).preview, t("liveDir.rename", 6, "acc", "sum", "move"));
	assert.strictEqual(ld.previewFor(at("#acc >rename"), LC_LINE, ld.parseDirective("#acc >rename"), {}).preview, t("liveDir.rename.needName", "", "acc"));
	// unused: the declaration, and what reads the name after it
	const unused = (target) => ld.unusedInfo(at("#" + target + " >unused"), LC_LINE, target);
	assert.deepStrictEqual([unused("tmp").declaration.line, unused("tmp").uses.length], [4, 0]);
	assert.strictEqual(unused("total").uses.length, 2);
	assert.strictEqual(unused("acc").uses.length >= 1, true, "`acc = acc + speed` reads it");
	assert.strictEqual(unused("zzz").declaration, null);
	assert.strictEqual(ld.unusedInfo("local a = 1\na = 2\n#a >unused", 2, "a").uses.length, 0, "an assignment that only sets it is no reading");
	assert.strictEqual(ld.previewFor(at("#tmp >unused"), LC_LINE, ld.parseDirective("#tmp >unused"), {}).preview, t("liveDir.unused", 5));
	assert.strictEqual(ld.previewFor(at("#tmp >unused"), LC_LINE, ld.parseDirective("#tmp >unused"), {}).declaration.line, 4);
	assert.strictEqual(ld.previewFor(at("#total >unused"), LC_LINE, ld.parseDirective("#total >unused"), {}).preview, t("liveDir.used", 2, 7));
});

test("liveDirectives commands: completion, aliases, the settings and the keys of the editor", function ()
{
	const ld = require("../src/liveDirectives");
	assert.deepStrictEqual(ld.COMMANDS, ["show_up", "show_down", "show_all", "type", "sign", "trace", "rename", "const", "unused", "calls"]);
	assert.deepStrictEqual(ld.MODIFY_COMMANDS, ["sign", "const", "rename"]);
	const items = ld.completionsFor("#acc >", 0, 6);
	assert.deepStrictEqual(items.map(i => i.label), ld.COMMANDS);
	assert.ok(items.every(i => i.kind == "command" && i.detail && i.documentation && !/^liveDir\./.test(i.detail + i.documentation)));
	// A command that takes a value: `#acc >rename = total`
	assert.deepStrictEqual(ld.parseDirective("#acc >rename = total"), { indent: "", comment: false, target: "acc", op: "rename", expr: "total" });
	assert.deepStrictEqual(ld.parseDirective("-- #self.hp >rename = self.life"), { indent: "", comment: true, target: "self.hp", op: "rename", expr: "self.life" });
	assert.strictEqual(ld.parseDirective("#acc >rename").expr, "");
	assert.strictEqual(ld.parseDirective("#acc >type").expr, "");
	assert.strictEqual(ld.parseDirective("#x = 5").expr, "5");
	for (const [d, active, modifying] of [["#a >show_up", true, false], ["#a >show_all", true, false], ["#a >type", true, false], ["#a >trace", true, false], ["#a >unused", true, false], ["#a >calls", true, false],
		["#a >sign", true, true], ["#a >const", true, true], ["#a >rename = b", true, true], ["#a >rename", true, true], ["#a = 1", true, true], ["#a =", false, true], ["#a >", false, false], ["#a >nope", false, false]])
	{
		assert.deepStrictEqual([ld.isActive(ld.parseDirective(d)), ld.isModifying(ld.parseDirective(d))], [active, modifying], d);
	}
	// The aliases and a new separator work for every command, also the ones with a value.
	const syn = { prefix: "@", commandSeparator: "::", commandAliases: { r: "rename", s: "sign", all: "show_all" } };
	assert.deepStrictEqual(ld.parseDirective("@acc :: r = sum", syn), { indent: "", comment: false, target: "acc", op: "rename", expr: "sum" });
	assert.strictEqual(ld.parseDirective("@return::s", syn).op, "sign");
	assert.strictEqual(ld.parseDirective("-- @acc::all", syn).op, "show_all");
	assert.deepStrictEqual(ld.completionsFor("@acc ::", 0, 7, syn).map(i => i.label), ld.COMMANDS.concat(["r", "s", "all"]));
	const text = "function f()\n    local acc = 2\n    @acc::r = sum\n    return acc\nend";
	assert.strictEqual(ld.applyDirectiveCommand(text, 2, ld.parseDirective("    @acc::r = sum", syn), "    ", "\n", syn).text, "function f()\n    local sum = 2\n    return sum\nend");
	// The settings accept them
	const settingsModel = require("../src/settingsModel");
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	assert.deepStrictEqual(pkg.contributes.configuration.properties["plua.liveDirectives.commandAliases"].additionalProperties.enum, ld.COMMANDS);
	assert.strictEqual(settingsModel.validateChange(pkg, "plua.liveDirectives.commandAliases", { r: "rename", c: "calls", u: "unused" }).ok, true);
	assert.strictEqual(settingsModel.validateChange(pkg, "plua.liveDirectives.commandAliases", { r: "format" }).ok, false);
	// Every command has its texts, in both languages
	const i18n = require("../src/i18n");
	for (const c of ld.COMMANDS)
	{
		assert.notStrictEqual(i18n.t("liveDir.cmd." + c), "liveDir.cmd." + c, c);
		assert.notStrictEqual(i18n.t("liveDir.cmdDoc." + c), "liveDir.cmdDoc." + c, c);
	}
	for (const key of ["liveDir.all", "liveDir.type", "liveDir.sign", "liveDir.sign.exists", "liveDir.constAdd", "liveDir.const.changed", "liveDir.rename", "liveDir.rename.taken", "liveDir.unused",
		"liveDir.used", "liveDir.calls", "liveDir.noCalls", "liveDir.removeDecl", "liveDir.unusedNote", "liveDir.hoverPlaces", "liveDir.hoverSteps", "liveDir.kind.use"])
	{
		assert.notStrictEqual(i18n.t(key), key, key);
	}
	// The editor: the quick fix for an unused variable, the hint that fades it, the hover with the places.
	const source = fs.readFileSync(path.join(__dirname, "..", "src", "liveDirectivesEditor.js"), "utf8");
	assert.ok(/plua\.liveDirectives\.removeDeclaration/.test(source) && /DiagnosticTag\.Unnecessary/.test(source) && /liveDir\.hoverPlaces/.test(source) && /applyDirectiveCommand/.test(source));
});
