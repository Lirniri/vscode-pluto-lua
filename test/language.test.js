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
	const expectNothing = ["", "local x = 1", "if x then return end", "else", "elseif y then", "case 1:", "default:", "catch e then",
		"-- if x then", "print(\"if x then\")", "function foo() end", "$if DEBUG then", "local t = {", "x = y", "$declare function f(a: string): number"];
	for (const line of expectNothing)
	{
		assert.strictEqual(closerFor(line), null, line);
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
	vscode.config["pluto.hover.maxBodyLines"] = 2;
	vscode.config["pluto.hover.showFunctionBody"] = true;
	assert(hover("function a()\n    print(1)\n    print(2)\n    print(3)\nend\n|a()").includes("-- ... (+"));
	vscode.config["pluto.hover.showFunctionBody"] = false;
	assert(!hover("function a()\n    print(1)\nend\n|a()").includes("\n\n---\n\n"));
	delete vscode.config["pluto.hover.showFunctionBody"];
	delete vscode.config["pluto.hover.maxBodyLines"];
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
		vscode.config["pluto.hover.maxDeclarations"] = 2;
		const some = providers.hoverProvider.provideHover(document, position).contents;
		assert.strictEqual(some.length, 4);
		assert(some[3].value.includes("(5)"));
		delete vscode.config["pluto.hover.maxDeclarations"];

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
	vscode.config["pluto.completion.autoTriggerTypes"] = false;
	assert.deepStrictEqual(typed("function f(a: |", " "), []);
	assert.deepStrictEqual(typed("function f(a:|", ":"), []);
	assert(complete("function f(a: |").labels.includes("int?"), "Ctrl+Space still works");
	delete vscode.config["pluto.completion.autoTriggerTypes"];

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
		vscode.config["pluto.completion.autoTriggerTypes"] = false;
		assert.strictEqual(triggerTypeSuggest(change(doc, ":", 0, 12)), false);
		delete vscode.config["pluto.completion.autoTriggerTypes"];
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
		vscode.config["pluto.highlight.nullableTypeColor"] = "#EEEEEE";
		highlighter.rebuild();
		assert(types[0].disposed && types.length == 2 && types[1].options.dark.color == "#EEEEEE");
		vscode.config["pluto.highlight.nullableTypes"] = false;
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
		delete vscode.config["pluto.highlight.nullableTypeColor"];
		delete vscode.config["pluto.highlight.nullableTypes"];
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

test("i18n: applyLanguage reads pluto.language and vscode.env.language, and switches on the fly", function ()
{
	const { applyLanguage } = require("../src/extension");
	try
	{
		vscode.env = { language: "ru-RU" };
		assert.strictEqual(applyLanguage(), "ru");
		assert.strictEqual(i18n.getLanguage(), "ru");
		assert.strictEqual(i18n.t("hover.line", 7), "Строка 7");
		vscode.config["pluto.language"] = "en"; // pinned by hand, as `onDidChangeConfiguration` would pick up
		assert.strictEqual(applyLanguage(), "en");
		assert.strictEqual(i18n.t("hover.line", 7), "Line 7");
		vscode.env = { language: "en" };
		vscode.config["pluto.language"] = "auto";
		assert.strictEqual(applyLanguage(), "en");
		vscode.config["pluto.language"] = "ru";
		assert.strictEqual(applyLanguage(), "ru");
		delete vscode.config["pluto.language"];
		vscode.env = { language: "de" };
		assert.strictEqual(applyLanguage(), "en");
		delete vscode.env; // a host without `env` is English
		assert.strictEqual(applyLanguage(), "en");
	}
	finally
	{
		delete vscode.env;
		delete vscode.config["pluto.language"];
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
	const language = pkg.contributes.configuration.properties["pluto.language"];
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

testAsync("pluto.lua.enable: Lua support follows the setting without a reload", async function ()
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
		vscode.config["pluto.lua.enable"] = false;
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
		// Lua files are still read for Pluto code (pluto.lua.indexFiles), but offer no features of their own.
		await svc.scan();
		assert(svc.index.lookup("hello_lua").length == 1);
		assert.deepStrictEqual(lp.workspaceSymbolProvider.provideWorkspaceSymbols("hello_lua"), []);

		// On again.
		delete vscode.config["pluto.lua.enable"];
		controller.refresh();
		assert.strictEqual(registrations.length, 18);
		assert(registrations.slice(12).every(r => hasLua(r.selector)));
		manager.recheckAll(false);
		assert.deepStrictEqual(diagnosticsOf(luaDoc), ["missing-module"]);

		// Indexing is separate: Lua files can be kept out of the index while the features stay on.
		vscode.config["pluto.lua.indexFiles"] = false;
		await svc.scan();
		assert.strictEqual(svc.index.lookup("hello_lua").length, 0);
		const record = svc.getRecord(luaDoc);
		assert.strictEqual(record.excluded, true, "an open Lua file works on its own");
		assert(!svc.index.files.has(luaDoc.uri.toString()));
		delete vscode.config["pluto.lua.indexFiles"];
		// The older setting still switches Lua indexing off.
		vscode.config["pluto.index.includeLua"] = false;
		await svc.scan();
		assert.strictEqual(svc.index.lookup("hello_lua").length, 0);
		delete vscode.config["pluto.index.includeLua"];
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

		// pluto.workspace.exclude, applied incrementally.
		vscode.config["pluto.workspace.exclude"] = ["**/vendor/**"];
		await service.scan({ incremental: true });
		assert.deepStrictEqual(names(service), ["mainFn"]);
		assert.strictEqual(service.index.manifests.size, 0, "manifests in excluded folders are dropped too");

		// Editing an ignore file: the file it now covers is removed from the index.
		disk.set("/ws/.plutoignore", "legacy/**\nsrc/main.pluto\n");
		await service.scan({ incremental: true });
		assert.deepStrictEqual(names(service), []);

		// pluto.workspace.ignoreFiles without .plutoignore, and useGitignore off.
		vscode.config["pluto.workspace.ignoreFiles"] = [".gitignore"];
		vscode.config["pluto.workspace.useGitignore"] = false;
		await service.scan({ incremental: true });
		assert.deepStrictEqual(names(service), ["buildFn", "generatedFn", "legacyFn", "mainFn"]);

		// search.exclude, and pluto.workspace.useSearchExclude.
		vscode.config["search.exclude"] = { "**/build": true, "**/legacy/**": false };
		await service.scan({ incremental: true });
		assert.deepStrictEqual(names(service), ["generatedFn", "legacyFn", "mainFn"]);
		vscode.config["pluto.workspace.useSearchExclude"] = false;
		await service.scan({ incremental: true });
		assert.deepStrictEqual(names(service), ["buildFn", "generatedFn", "legacyFn", "mainFn"]);

		// files.exclude always applies; the legacy pluto.index.exclude setting still works.
		vscode.config["files.exclude"] = { "legacy": true };
		vscode.config["pluto.index.exclude"] = ["build/**"];
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
	const schema = pkg.contributes.configuration.properties["pluto.highlight.colors"].properties;
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
	for (const prop of Object.values(pkg.contributes.configuration.properties["pluto.highlight.colors"].properties))
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
	assert.deepStrictEqual(pkg.contributes.configuration.properties["pluto.workspace.ignoreFiles"].default, [".gitignore", ".plutoignore", ".luaignore"]);
	const wf = fs.readFileSync(path.join(__dirname, "..", "src", "workspaceFilter.js"), "utf8");
	assert(wf.includes('[".gitignore", ".plutoignore", ".luaignore"]'));
	// All settings of the JSON checks are declared with a default.
	const props = pkg.contributes.configuration.properties;
	assert.deepStrictEqual(props["pluto.json.files"].default, ["**/info.json"]);
	assert.deepStrictEqual(props["pluto.json.extensions"].default, [".pluto", ".lua"]);
	assert.strictEqual(props["pluto.json.checkAllPaths"].default, false);
	assert.strictEqual(props["pluto.json.notifyNoFolder"].default, true);
	assert.strictEqual(props["pluto.lua.checkSyntax"].default, true);
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
	for (const key of ["pluto.format.multilineParams", "pluto.format.multilineTables"])
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
		vscode.config["pluto.completion.defaultValues"] = false;
		try
		{
			assert.deepStrictEqual(labels("function name(test: bool|)"), []);
		}
		finally
		{
			delete vscode.config["pluto.completion.defaultValues"];
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
	assert.strictEqual(props["pluto.highlight.paramNoDefault"].default, true);
	assert.strictEqual(props["pluto.highlight.paramNoDefaultColor"].format, "color-hex");
	assert.strictEqual(props["pluto.highlight.paramNoDefaultLightColor"].format, "color-hex");
	assert.strictEqual(props["pluto.completion.defaultValues"].default, true);
	assert.strictEqual(props["pluto.completion.defaultValuesDelayMs"].default, 800);
	assert.strictEqual(props["pluto.completion.defaultValuesDelayMs"].minimum, 0);
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
	assert.strictEqual(props["pluto.format.newLineAfterComma"].default, true);
	assert.strictEqual(props["pluto.format.newLineAfterCommaDelayMs"].default, 700);
	assert.strictEqual(props["pluto.format.suggestParens"].default, true);
	assert.strictEqual(props["pluto.format.suggestTableKeyAssign"].default, true);
	assert.strictEqual(props["pluto.format.suggestBlockWords"].default, true);
	assert.strictEqual(props["pluto.format.fixMismatchedBrackets"].default, "suggest");
	assert.deepStrictEqual(props["pluto.format.fixMismatchedBrackets"].enum, ["off", "suggest", "auto"]);
	assert.strictEqual(props["pluto.format.fixMismatchedBrackets"].enumDescriptions.length, 3);
	assert.strictEqual(props["pluto.format.fixMismatchedBracketsDelayMs"].default, 1200);
	assert.strictEqual(props["pluto.diagnostics.duplicateParams"].default, "warning");
	assert.deepStrictEqual(props["pluto.diagnostics.duplicateParams"].enum, ["warning", "error", "off"]);
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
	assert.strictEqual(props["pluto.format.nameStyle"].default, "short");
	assert.deepStrictEqual(props["pluto.format.nameStyle"].enum, ["short", "full"]);
	assert.deepStrictEqual(Object.keys(props["pluto.format.names"].properties), ["index", "key", "value", "table"]);
	assert.strictEqual(props["pluto.format.suggestFor"].default, true);
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
	const prop = pkg.contributes.configuration.properties["pluto.format.ifBlockWord"];
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
	vscode.config["pluto.hover.forPreview"] = false;
	try
	{
		assert(!hover("fo|r i = 1, 10, 2 do end").includes("takes the values"));
	}
	finally
	{
		delete vscode.config["pluto.hover.forPreview"];
	}
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	assert.strictEqual(pkg.contributes.configuration.properties["pluto.hover.forPreview"].default, true);
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
	assert.strictEqual(where("pluto.language"), "general");
	assert.strictEqual(where("pluto.workspace.ignoreFiles"), "index");
	assert.strictEqual(where("pluto.lua.compilerPath"), "lua");
	assert.strictEqual(where("pluto.completion.defaultValues"), "completion");
	assert.strictEqual(where("pluto.hover.forPreview"), "hover");
	assert.strictEqual(where("pluto.outline.calls"), "outline");
	assert.strictEqual(where("pluto.diagnostics.duplicateParams"), "diagnostics");
	assert.strictEqual(where("pluto.highlight.colors"), "highlight");
	assert.strictEqual(where("pluto.format.ifBlockWord"), "typing");
	assert.strictEqual(where("pluto.json.files"), "json");
	assert.strictEqual(item("pluto.autoCloseBlocks").kind, "boolean");
	assert.strictEqual(item("pluto.format.ifBlockWord").kind, "enum");
	assert.strictEqual(item("pluto.index.maxFiles").kind, "number");
	assert.strictEqual(item("pluto.workspace.exclude").kind, "list");
	assert.strictEqual(item("pluto.lua.compilerPath").kind, "text");
	assert.strictEqual(item("pluto.highlight.paramNoDefaultColor").kind, "color");
	assert.strictEqual(item("pluto.highlight.nullableTypeColor").kind, "color");
	assert.strictEqual(item("pluto.highlight.colors").kind, "colors");
	assert.strictEqual(item("pluto.highlight.tableBracketColors").kind, "bracketColors");
	assert.strictEqual(item("pluto.format.names").kind, "map");
	assert.deepStrictEqual(item("pluto.format.names").fields, ["index", "key", "value", "table"]);
	assert.deepStrictEqual(item("pluto.format.ifBlockWord").options.map(o => o.value), ["auto", "then", "do", "off"]);
	assert.strictEqual(item("pluto.index.maxFiles").min, 1);
	assert.strictEqual(item("pluto.highlight.colors").categories.length, 11);
	assert.strictEqual(item("pluto.highlight.colors").categories[0].name, "functionName");
	// The texts are the ones of the nls file; no `%key%` is left over.
	assert.strictEqual(item("pluto.json.severity").description, nls["pluto.json.severity.markdownDescription"]);
	assert(model.tabs.flatMap(t => t.items).every(i => !/^%.*%$/.test(i.description) && i.description.length > 0), "every setting has its text");
	assert(model.tabs.flatMap(t => t.items).filter(i => i.options).every(i => i.options.every(o => o.label && !/^%/.test(o.label))));
	// The value of a setting is the one in force.
	const changed = settingsModel.buildModel(pkg, nls, (key) => key == "pluto.format.suggestFor" ? false : props[key].default, {});
	assert.strictEqual(changed.tabs.flatMap(t => t.items).find(i => i.key == "pluto.format.suggestFor").value, false);
	assert.strictEqual(settingsModel.tabOf("pluto.something.new"), "general", "a setting no tab claims lands on the first tab");
});

test("settings panel: only allowed values are saved", function ()
{
	const { pkg } = readManifest();
	const check = (key, value) => settingsModel.validateChange(pkg, key, value);
	const ok = (key, value) => { const r = check(key, value); assert(r.ok, key + " " + JSON.stringify(value) + " " + r.error); return r; };
	const bad = (key, value) => { const r = check(key, value); assert(!r.ok, key + " " + JSON.stringify(value) + " should be refused"); return r.error; };
	// Which settings may be written: ours, and only the ones that exist.
	bad("editor.fontSize", 20);
	bad("pluto.nothing", true);
	bad("__proto__", true);
	bad("constructor", true);
	// Switches, choices, numbers, texts.
	assert.strictEqual(ok("pluto.autoCloseBlocks", false).isDefault, false);
	assert.strictEqual(ok("pluto.autoCloseBlocks", true).isDefault, true, "the default is not written to settings.json");
	bad("pluto.autoCloseBlocks", "yes");
	assert.strictEqual(ok("pluto.format.ifBlockWord", "do").value, "do");
	bad("pluto.format.ifBlockWord", "later");
	assert.strictEqual(ok("pluto.index.maxFiles", "250").value, 250, "a number arrives as text from the field");
	assert.strictEqual(ok("pluto.index.maxFiles", 12.7).value, 13, "an integer setting is rounded");
	bad("pluto.index.maxFiles", 0);
	bad("pluto.index.maxFiles", "many");
	bad("pluto.format.newLineAfterCommaDelayMs", 99999);
	assert.strictEqual(ok("pluto.lua.compilerPath", "C:/lua/luac.exe").value, "C:/lua/luac.exe");
	bad("pluto.lua.compilerPath", 5);
	// Colors: a hex color, an empty one goes back to the default.
	assert.strictEqual(ok("pluto.highlight.paramNoDefaultColor", "#ff8800").value, "#ff8800");
	assert.strictEqual(ok("pluto.highlight.paramNoDefaultColor", "#F80").value, "#F80");
	assert.strictEqual(ok("pluto.highlight.paramNoDefaultColor", "#ff880080").value, "#ff880080");
	assert.strictEqual(ok("pluto.highlight.paramNoDefaultColor", "").isDefault, true);
	bad("pluto.highlight.paramNoDefaultColor", "orange");
	bad("pluto.highlight.paramNoDefaultColor", "#12");
	// Lists are trimmed, empty lines go.
	assert.deepStrictEqual(ok("pluto.workspace.exclude", [" **/vendor/** ", "", "  "]).value, ["**/vendor/**"]);
	bad("pluto.workspace.exclude", "**/vendor/**");
	bad("pluto.workspace.exclude", [1]);
	// The colors of the highlighting: every part is checked, an empty one is dropped, a transparent one is refused.
	const colors = ok("pluto.highlight.colors", { functionName: { color: "#ff8800", lightColor: "#007a62", fontStyle: "bold", darkColor: "" }, type: {}, keyword: "#c586c0 bold" });
	assert.deepStrictEqual(colors.value, { functionName: { color: "#ff8800", lightColor: "#007a62", fontStyle: "bold" }, keyword: "#c586c0 bold" });
	assert.strictEqual(ok("pluto.highlight.colors", {}).isDefault, true);
	bad("pluto.highlight.colors", { functionName: { color: "#0000" } });
	bad("pluto.highlight.colors", { functionName: { color: "blue" } });
	bad("pluto.highlight.colors", { functionName: { fontStyle: "bolt" } });
	bad("pluto.highlight.colors", { notACategory: { color: "#ff8800" } });
	bad("pluto.highlight.colors", []);
	bad("pluto.highlight.colors", "#ff8800");
	assert.deepStrictEqual(ok("pluto.highlight.tableBracketColors", [{ color: "#e6b450" }, {}, "#59c2ff"]).value, [{ color: "#e6b450" }, "#59c2ff"]);
	bad("pluto.highlight.tableBracketColors", [{ color: "#0000" }]);
	bad("pluto.highlight.tableBracketColors", "#ff8800");
	// The words of your own.
	assert.deepStrictEqual(ok("pluto.format.names", { value: "item", key: "", table: " list " }).value, { value: "item", table: "list" });
	bad("pluto.format.names", { value: "my item" });
	bad("pluto.format.names", { other: "x" });
	assert.strictEqual(ok("pluto.format.names", {}).isDefault, true);
	// The answers are in the language in use.
	require("../src/i18n").setLanguage("ru");
	try
	{
		assert.strictEqual(bad("pluto.format.newLineAfterCommaDelayMs", 99999), "ожидается число от 0 до 10000");
		assert.strictEqual(bad("pluto.format.ifBlockWord", "later"), "это не один из вариантов");
	}
	finally
	{
		require("../src/i18n").setLanguage("en");
	}
	assert.strictEqual(bad("pluto.format.newLineAfterCommaDelayMs", 99999), "a number from 0 to 10000 is expected");
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
	assert.strictEqual(nls["command.openSettings.title"], "Pluto: Settings");
	assert.strictEqual(nlsRu["command.openSettings.title"], "Pluto: Настройки");
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
	// The colon after the values, shown after a pause; not when it is there, or where the line goes on.
	assert.deepStrictEqual(kinds("switch x do\n    case 1@\nend"), ["case-colon::~"]);
	assert.deepStrictEqual(kinds("switch x do\n    case 2, 3@\nend"), ["case-colon::~"]);
	assert.deepStrictEqual(kinds("switch x do\n    case \"a\"@\nend"), ["case-colon::~"]);
	assert.deepStrictEqual(kinds("switch x do\n    case 1 @\nend"), ["case-colon::~"]);
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
		assert.strictEqual(props["pluto.format." + key].default, true, key);
	}
	assert.strictEqual(props["pluto.format.suggestParamTypeDelayMs"].default, 600);
	assert.strictEqual(props["pluto.highlight.paramNoType"].default, true);
	assert.strictEqual(props["pluto.highlight.caseNoColon"].default, true);
	assert.deepStrictEqual(props["pluto.diagnostics.returnTypes"].enum, ["warning", "error", "off"]);
	assert.deepStrictEqual(props["pluto.diagnostics.caseFallthrough"].enum, ["off", "hint"]);
	assert.strictEqual(props["pluto.diagnostics.caseFallthrough"].default, "off");
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
	assert.strictEqual(pkg.contributes.configuration.properties["pluto.format.suggestConstructor"].default, true);
});
