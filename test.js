const fs = require("fs");
const path = require("path");
const vsctm = require("vscode-textmate");
const onig = require("vscode-oniguruma");

async function loadGrammar()
{
    const wasmPath = require.resolve("vscode-oniguruma/release/onig.wasm");
    const wasm = fs.readFileSync(wasmPath).buffer;
    await onig.loadWASM(wasm);
    const onigLib = {
        createOnigScanner: (sources) => new onig.OnigScanner(sources),
        createOnigString: (str) => new onig.OnigString(str)
    };

    const registry = new vsctm.Registry({
        onigLib,
        loadGrammar: function (scopeName)
        {
            if (scopeName == "source.pluto")
            {
                const tmLanguage = fs.readFileSync(path.join(__dirname, "Pluto.tmbundle", "Syntaxes", "Pluto.tmLanguage"), "utf8");
                return vsctm.parseRawGrammar(tmLanguage);
            }
            return null;
        }
    });

    return registry.loadGrammar("source.pluto");
}

async function main()
{
    const grammar = await loadGrammar();

    const createClassificationString = function (code)
    {
        const { tokens } = grammar.tokenizeLine(code);
        const res = [];
        for (const token of tokens)
        {
            if (token.scopes.length > 1)
            {
                res.push(" ".repeat(token.startIndex));
                res.push("-".repeat(token.endIndex - token.startIndex));
                res.push(" ".repeat(1 + code.length - token.endIndex));
                res.push(token.scopes[token.scopes.length - 1]);
                res.push("\n");
            }
        }
        return res.join("");
    };

    let ok = true;
    const checkClassification = function (code, ...expected)
    {
        expected = expected.join("\n") + "\n";

        const actual = createClassificationString(code);
        if (actual != expected)
        {
            console.log(code + " MISMATCH");
            console.log(actual);
            ok = false;
        }
    };

    checkClassification(
        `local enums = {}`,
        `-----            storage.modifier.pluto`,
        `            -    keyword.operator.assignment.pluto`,
        `              -  punctuation.section.table.begin.pluto`,
        `               - punctuation.section.table.end.pluto`
    );
    checkClassification(
        `local deez = || -> 1`,
        `-----                storage.modifier.pluto`,
        `      ----           entity.name.function.arrow.pluto`,
        `           -         keyword.operator.assignment.pluto`,
        `             -       punctuation.section.group.begin.pluto`,
        `              -      punctuation.section.group.end.pluto`,
        `                --   storage.type.function.arrow.pluto`,
        `                   - constant.numeric.integer.pluto`
    );

    checkClassification(
        `local p: { x: number; y: number }`,
        `-----                             storage.modifier.pluto`,
        `     --                           meta.typehint.table.pluto`,
        `       -                          punctuation.separator.colon.pluto`,
        `        -                         meta.typehint.table.pluto`,
        `         -                        punctuation.section.table.begin.pluto`,
        `          -                       meta.typehint.table.pluto`,
        `           -                      variable.other.field.pluto`,
        `            -                     punctuation.separator.colon.pluto`,
        `             -                    meta.typehint.pluto`,
        `              ------              storage.type.primitive.pluto`,
        `                    -             punctuation.terminator.semicolon.pluto`,
        `                     -            meta.typehint.table.pluto`,
        `                      -           variable.other.field.pluto`,
        `                       -          punctuation.separator.colon.pluto`,
        `                        -         meta.typehint.pluto`,
        `                         ------   storage.type.primitive.pluto`,
        `                               -  meta.typehint.table.pluto`,
        `                                - punctuation.section.table.end.pluto`
    );

    checkClassification(
        `local p: { x: number, y: number }`,
        `-----                             storage.modifier.pluto`,
        `     --                           meta.typehint.table.pluto`,
        `       -                          punctuation.separator.colon.pluto`,
        `        -                         meta.typehint.table.pluto`,
        `         -                        punctuation.section.table.begin.pluto`,
        `          -                       meta.typehint.table.pluto`,
        `           -                      variable.other.field.pluto`,
        `            -                     punctuation.separator.colon.pluto`,
        `             -                    meta.typehint.pluto`,
        `              ------              storage.type.primitive.pluto`,
        `                    -             punctuation.separator.comma.pluto`,
        `                     -            meta.typehint.table.pluto`,
        `                      -           variable.other.field.pluto`,
        `                       -          punctuation.separator.colon.pluto`,
        `                        -         meta.typehint.pluto`,
        `                         ------   storage.type.primitive.pluto`,
        `                               -  meta.typehint.table.pluto`,
        `                                - punctuation.section.table.end.pluto`
    );

    checkClassification(
        `local function f(cb: { a: string })`,
        `-----                               storage.modifier.pluto`,
        `      --------                      storage.type.function.pluto`,
        `              -                     meta.function.pluto`,
        `               -                    entity.name.function.pluto`,
        `                -                   punctuation.section.group.begin.pluto`,
        `                 --                 variable.parameter.function.pluto`,
        `                   -                punctuation.separator.colon.pluto`,
        `                    -               meta.typehint.table.pluto`,
        `                     -              punctuation.section.table.begin.pluto`,
        `                      -             meta.typehint.table.pluto`,
        `                       -            variable.other.field.pluto`,
        `                        -           punctuation.separator.colon.pluto`,
        `                         -          meta.typehint.pluto`,
        `                          ------    storage.type.primitive.pluto`,
        `                                -   meta.typehint.table.pluto`,
        `                                 -  punctuation.section.table.end.pluto`,
        `                                  - punctuation.section.group.end.pluto`
    );

    checkClassification(
        `local f: function(a: string): int = tonumber`,
        `-----                                        storage.modifier.pluto`,
        `       -                                     punctuation.separator.colon.pluto`,
        `        -                                    meta.typehint.function.pluto`,
        `         --------                            storage.type.function.pluto`,
        `                 -                           punctuation.section.group.begin.pluto`,
        `                  -                          variable.parameter.function.pluto`,
        `                   -                         punctuation.separator.colon.pluto`,
        `                    -                        meta.typehint.pluto`,
        `                     ------                  storage.type.primitive.pluto`,
        `                           -                 punctuation.section.group.end.pluto`,
        `                            -                punctuation.separator.colon.pluto`,
        `                             -               meta.typehint.pluto`,
        `                              ---            storage.type.primitive.pluto`,
        `                                  -          keyword.operator.assignment.pluto`
    );

    checkClassification(
        `local function f(cb: function(a: string): int)`,
        `-----                                          storage.modifier.pluto`,
        `      --------                                 storage.type.function.pluto`,
        `              -                                meta.function.pluto`,
        `               -                               entity.name.function.pluto`,
        `                -                              punctuation.section.group.begin.pluto`,
        `                 --                            variable.parameter.function.pluto`,
        `                   -                           punctuation.separator.colon.pluto`,
        `                    -                          meta.typehint.function.pluto`,
        `                     --------                  storage.type.function.pluto`,
        `                             -                 punctuation.section.group.begin.pluto`,
        `                              -                variable.parameter.function.pluto`,
        `                               -               punctuation.separator.colon.pluto`,
        `                                -              meta.typehint.pluto`,
        `                                 ------        storage.type.primitive.pluto`,
        `                                       -       punctuation.section.group.end.pluto`,
        `                                        -      punctuation.separator.colon.pluto`,
        `                                         -     meta.typehint.pluto`,
        `                                          ---  storage.type.primitive.pluto`,
        `                                             - punctuation.section.group.end.pluto`
    );

    checkClassification(
        `local function f(): (bool, int)`,
        `-----                           storage.modifier.pluto`,
        `      --------                  storage.type.function.pluto`,
        `              -                 meta.function.pluto`,
        `               -                entity.name.function.pluto`,
        `                -               punctuation.section.group.begin.pluto`,
        `                 -              punctuation.section.group.end.pluto`,
        `                  -             punctuation.separator.colon.pluto`,
        `                   -            meta.function.pluto`,
        `                    ----------- storage.type.primitive.pluto`
    );

    checkClassification(
        `$type StringOrNumber = string|number`,
        `-----                                storage.type.named.pluto`,
        `     -                               meta.type.named.pluto`,
        `      --------------                 entity.name.type.pluto`,
        `                    -                meta.type.named.pluto`,
        `                     -               keyword.operator.assignment.pluto`,
        `                      -              meta.type.named.pluto`,
        `                       ------------- storage.type.primitive.pluto`
    );
    checkClassification(
        `$type Point = { x: number, y: number }`,
        `-----                                  storage.type.named.pluto`,
        `     -                                 meta.type.named.pluto`,
        `      -----                            entity.name.type.pluto`,
        `           -                           meta.type.named.pluto`,
        `            -                          keyword.operator.assignment.pluto`,
        `             -                         meta.type.named.pluto`,
        `              -                        punctuation.section.table.begin.pluto`,
        `               -                       meta.typehint.table.pluto`,
        `                -                      variable.other.field.pluto`,
        `                 -                     punctuation.separator.colon.pluto`,
        `                  -                    meta.typehint.pluto`,
        `                   ------              storage.type.primitive.pluto`,
        `                         -             punctuation.separator.comma.pluto`,
        `                          -            meta.typehint.table.pluto`,
        `                           -           variable.other.field.pluto`,
        `                            -          punctuation.separator.colon.pluto`,
        `                             -         meta.typehint.pluto`,
        `                              ------   storage.type.primitive.pluto`,
        `                                    -  meta.typehint.table.pluto`,
        `                                     - punctuation.section.table.end.pluto`
    );
    checkClassification(
        `$type Point = { x: number; y: number }`,
        `-----                                  storage.type.named.pluto`,
        `     -                                 meta.type.named.pluto`,
        `      -----                            entity.name.type.pluto`,
        `           -                           meta.type.named.pluto`,
        `            -                          keyword.operator.assignment.pluto`,
        `             -                         meta.type.named.pluto`,
        `              -                        punctuation.section.table.begin.pluto`,
        `               -                       meta.typehint.table.pluto`,
        `                -                      variable.other.field.pluto`,
        `                 -                     punctuation.separator.colon.pluto`,
        `                  -                    meta.typehint.pluto`,
        `                   ------              storage.type.primitive.pluto`,
        `                         -             punctuation.terminator.semicolon.pluto`,
        `                          -            meta.typehint.table.pluto`,
        `                           -           variable.other.field.pluto`,
        `                            -          punctuation.separator.colon.pluto`,
        `                             -         meta.typehint.pluto`,
        `                              ------   storage.type.primitive.pluto`,
        `                                    -  meta.typehint.table.pluto`,
        `                                     - punctuation.section.table.end.pluto`
    );
    checkClassification(
        `$type Callback = function(a: string): int`,
        `-----                                     storage.type.named.pluto`,
        `     -                                    meta.type.named.pluto`,
        `      --------                            entity.name.type.pluto`,
        `              -                           meta.type.named.pluto`,
        `               -                          keyword.operator.assignment.pluto`,
        `                -                         meta.type.named.pluto`,
        `                 --------                 storage.type.function.pluto`,
        `                         -                punctuation.section.group.begin.pluto`,
        `                          -               variable.parameter.function.pluto`,
        `                           -              punctuation.separator.colon.pluto`,
        `                            -             meta.typehint.pluto`,
        `                             ------       storage.type.primitive.pluto`,
        `                                   -      punctuation.section.group.end.pluto`,
        `                                    -     punctuation.separator.colon.pluto`,
        `                                     -    meta.typehint.pluto`,
        `                                      --- storage.type.primitive.pluto`
    );
    checkClassification(
        `local f: Callback`,
        `-----             storage.modifier.pluto`,
        `       -          punctuation.separator.colon.pluto`,
        `         -------- storage.type.primitive.pluto`
    );
    checkClassification(
        `$declare _PVERSION: string`,
        `--------                   storage.modifier.pluto`,
        `                  -        punctuation.separator.colon.pluto`,
        `                    ------ storage.type.primitive.pluto`
    );
    checkClassification(
        `$declare function tonumber(str: string, base: ?number): number`,
        `--------                                                       storage.modifier.pluto`,
        `        -                                                      meta.function.pluto`,
        `         --------                                              storage.type.function.pluto`,
        `                 -                                             meta.function.pluto`,
        `                  --------                                     entity.name.function.pluto`,
        `                          -                                    punctuation.section.group.begin.pluto`,
        `                           ---                                 variable.parameter.function.pluto`,
        `                              -                                punctuation.separator.colon.pluto`,
        `                               -                               meta.typehint.pluto`,
        `                                ------                         storage.type.primitive.pluto`,
        `                                      -                        punctuation.separator.comma.pluto`,
        `                                       -                       meta.function.pluto`,
        `                                        ----                   variable.parameter.function.pluto`,
        `                                            -                  punctuation.separator.colon.pluto`,
        `                                             -                 meta.typehint.pluto`,
        `                                              -------          storage.type.primitive.pluto`,
        `                                                     -         punctuation.section.group.end.pluto`,
        `                                                      -        punctuation.separator.colon.pluto`,
        `                                                       -       meta.function.pluto`,
        `                                                        ------ storage.type.primitive.pluto`
    );

    checkClassification(
        `$if true then`,
        `-             keyword.operator.logical.pluto`,
        ` --           keyword.control.pluto`,
        `    ----      constant.language.pluto`,
        `         ---- keyword.control.pluto`
    );
    checkClassification(
        `$else`,
        `-     keyword.operator.logical.pluto`,
        ` ---- keyword.control.pluto`
    );
    checkClassification(
        `$end`,
        `-    keyword.operator.logical.pluto`,
        ` --- keyword.control.pluto`
    );

    const langConfig = JSON.parse(
        fs.readFileSync(path.join(__dirname, "language-config.json"), "utf8").replace(/\/\/.*$/gm, "")
    );
    const increaseIndentPattern = new RegExp(langConfig.indentationRules.increaseIndentPattern);
    const decreaseIndentPattern = new RegExp(langConfig.indentationRules.decreaseIndentPattern);
    const checkIndentation = function (code, inc, dec)
    {
        const incMatch = increaseIndentPattern.test(code);
        const decMatch = decreaseIndentPattern.test(code);
        if (incMatch != inc || decMatch != dec)
        {
            console.log(`Indentation mismatch for ${code}`);
            ok = false;
        }
    };

    checkIndentation("function foo()", true, false);
    checkIndentation("if cond then", true, false);
    checkIndentation("else", true, true);
    checkIndentation("end", false, true);
    checkIndentation("until finished", false, true);
    checkIndentation("repeat", true, false);
    checkIndentation("repeat until true", false, false);
    checkIndentation("repeat tick() until finished", false, false);
    checkIndentation("values = {", true, false);
    checkIndentation("}", false, true);
    checkIndentation("$type Func = function(_: string): void", false, false);
    checkIndentation("$declare function tonumber(str: string, base: ?number): number", false, false);
    checkIndentation("local entry", false, false);

    // Type hints are highlighted with or without a space after the colon; method calls are not types.
    const checkScope = function (code, word, scope, expected)
    {
        const { tokens } = grammar.tokenizeLine(code);
        const token = tokens.find(t => code.slice(t.startIndex, t.endIndex) == word);
        const has = !!token && token.scopes.includes(scope);
        if (has != expected)
        {
            console.log(`Scope mismatch: ${word} in ${code} should ${expected ? "" : "not "}be ${scope}`);
            ok = false;
        }
    };
    for (const [code, word] of [
        ["function f(a: int, b: string): bool", "bool"],
        ["function f(a:int, b:string):bool", "bool"],
        ["function f(a:int, b:string):bool", "string"],
        ["function f(a:int?, b:?string)", "int?"],
        ["function f(a:int?, b:?string)", "?string"],
        ["local x:int = 1", "int"],
        ["local x: int = 1", "int"],
        ["local x:Vehicle? = nil", "Vehicle?"],
    ])
    {
        checkScope(code, word, "storage.type.primitive.pluto", true);
    }
    checkScope("obj:method(1)", "method", "storage.type.primitive.pluto", false);
    checkScope("obj:method(1)", "method", "meta.method-call.pluto", true);
    checkScope("x = a ? b : c", "c", "storage.type.primitive.pluto", false);

    // Lambdas with typed parameters and a return type, as in `function f(a: int): int`.
    {
        const code = "local f = |x: int, y: ?string| -> bool? { return true }";
        checkScope(code, "x", "variable.parameter.function.pluto", true);
        checkScope(code, "y", "variable.parameter.function.pluto", true);
        checkScope(code, "int", "meta.typehint.pluto", true);
        checkScope(code, "int", "storage.type.primitive.pluto", true);
        checkScope(code, "?string", "storage.type.primitive.pluto", true);
        checkScope(code, "bool?", "meta.return-type.pluto", true);
        checkScope(code, "bool?", "storage.type.primitive.pluto", true);
        checkScope(code, "f", "entity.name.function.arrow.pluto", true);
        checkScope(code, "->", "storage.type.function.arrow.pluto", true);
        // Parameter types are not return types.
        checkScope(code, "int", "meta.return-type.pluto", false);
        // Lambdas without types keep working; an expression body is not a return type.
        checkScope("local g = |a, b| -> a + b", "a", "variable.parameter.function.pluto", true);
        checkScope("local g = |a| -> a", "g", "entity.name.function.arrow.pluto", true);
        checkScope("local g = |a| -> int", "int", "meta.return-type.pluto", false);
        // A bitwise or is not a lambda.
        checkScope("local x = b | c", "b", "variable.parameter.function.pluto", false);
        checkScope("local x = b | c", "|", "keyword.operator.logical.pluto", true);
        // Long lines must stay fast.
        const started = Date.now();
        grammar.tokenizeLine("local x = |" + "aaaa, ".repeat(3000) + "bbbb", vsctm.INITIAL);
        grammar.tokenizeLine("local x = |" + "aaaa: int, ".repeat(3000) + "|", vsctm.INITIAL);
        if (Date.now() - started > 2000)
        {
            console.log("Lambda rule is too slow on long lines: " + (Date.now() - started) + " ms");
            ok = false;
        }
    }

    // Function names with several segments: parameters and types are highlighted as in `function a.b(...)`.
    for (const code of [
        "function api.add(a: int, b: int): int",
        "function api.handlers.add(a: int, b: int): int",
        "function api.a.b.c.add(a: int, b: int): int",
        "function api.h:add(a: int, b: int): int",
        "function Atdar.natives.entity.get_height_above_ground(a: int, b: int): int",
    ])
    {
        checkScope(code, "add", "entity.name.function.pluto", !code.includes("Atdar"));
        checkScope(code, "a", "variable.parameter.function.pluto", true);
        checkScope(code, "a", "meta.function.pluto", true);
        checkScope(code, "a", "meta.function.incomplete.pluto", false);
    }
    checkScope("function Atdar.natives.entity.get_height_above_ground(a: int)", "get_height_above_ground", "entity.name.function.pluto", true);
    checkScope("function Atdar.natives.entity.get_height_above_ground(a: int)", "int", "storage.type.primitive.pluto", true);

    // User colors: the rules of src/highlightColors.js must really win in a TextMate theme, including the
    // depth of table braces chosen by descendant selectors.
    {
        const { buildRules } = require("./src/highlightColors");
        const rules = buildRules(
            { functionName: "#aa0001 bold", parameter: "#aa0002 italic", type: "#aa0003", keyword: "#aa0004", returnType: { color: "#aa0005", fontStyle: "bold" } },
            ["#110001", "#110002", "#110003"]);
        const themed = new vsctm.Registry({
            onigLib: Promise.resolve({ createOnigScanner: (s) => new onig.OnigScanner(s), createOnigString: (s) => new onig.OnigString(s) }),
            theme: { name: "test", settings: [{ settings: { foreground: "#999999" } }].concat(rules.map(r => ({ name: r.name, scope: r.scope, settings: r.settings }))) },
            loadGrammar: async (scopeName) => scopeName == "source.pluto"
                ? vsctm.parseRawGrammar(fs.readFileSync(path.join(__dirname, "Pluto.tmbundle", "Syntaxes", "Pluto.tmLanguage"), "utf8"))
                : null,
        });
        const themedGrammar = await themed.loadGrammar("source.pluto");
        const colorMap = themed.getColorMap();
        const colorsOf = function (lines)
        {
            let stack = vsctm.INITIAL;
            const out = [];
            for (const line of lines)
            {
                const r = themedGrammar.tokenizeLine2(line, stack);
                stack = r.ruleStack;
                for (let i = 0; i < r.tokens.length; i += 2)
                {
                    const start = r.tokens[i];
                    const end = i + 2 < r.tokens.length ? r.tokens[i + 2] : line.length;
                    const meta = r.tokens[i + 1];
                    out.push({ text: line.slice(start, end), color: String(colorMap[(meta & 0x00FF8000) >>> 15]).toLowerCase(), bold: !!(meta & 0x1000), italic: !!(meta & 0x800) });
                }
            }
            return out;
        };
        const expectColor = function (tokens, text, nth, color, what)
        {
            const found = tokens.filter(t => t.text == text)[nth];
            if (!found || found.color != color)
            {
                console.log(`Theme mismatch: ${what}: "${text}" #${nth} is ${found ? found.color : "missing"}, expected ${color}`);
                ok = false;
            }
            return found;
        };
        const braces = colorsOf(["local t = { { { { { } } } } }"]);
        // Opening braces: depths 1..5 use the palette in turn (110001, 110002, 110003, 110001, 110002) ...
        ["#110001", "#110002", "#110003", "#110001", "#110002"].forEach((c, i) => expectColor(braces, "{", i, c, "table depth " + (i + 1)));
        // ... and each closing brace has the color of its opening one.
        ["#110002", "#110001", "#110003", "#110002", "#110001"].forEach((c, i) => expectColor(braces, "}", i, c, "closing brace " + (i + 1)));
        const fn = colorsOf(["function api.handlers.add(a: int, b: int): int"]);
        expectColor(fn, "add", 0, "#aa0001", "function name");
        expectColor(fn, "a", 0, "#aa0002", "parameter");
        expectColor(fn, "int", 0, "#aa0003", "type");
        expectColor(fn, "(", 0, "#999999", "punctuation without a rule keeps the theme color");
        if (!(expectColor(fn, "add", 0, "#aa0001", "bold").bold))
        {
            console.log("Theme mismatch: function name should be bold");
            ok = false;
        }
        // The return type has its own color; the types inside the parameters keep the color of `type`.
        const ret = colorsOf(["function f(a: int, b: string?): void", "function g(a: bool): bool?", "local x: int = 1"]);
        expectColor(ret, "int", 0, "#aa0003", "type of a parameter");
        expectColor(ret, "string?", 0, "#aa0003", "nullable type of a parameter");
        expectColor(ret, "void", 0, "#aa0005", "return type");
        expectColor(ret, "bool", 0, "#aa0003", "type of a parameter (bool)");
        expectColor(ret, "bool?", 0, "#aa0005", "nullable return type");
        expectColor(ret, "int", 1, "#aa0003", "type of a local variable");
        if (!ret.find(t => t.text == "void").bold)
        {
            console.log("Theme mismatch: return type should be bold (object form of the style)");
            ok = false;
        }
        // A lambda's return type takes the color of `returnType`, the types of its parameters that of `type`.
        const lam = colorsOf(["local f = |x: int| -> bool { return true }"]);
        expectColor(lam, "int", 0, "#aa0003", "type of a lambda parameter");
        expectColor(lam, "bool", 0, "#aa0005", "return type of a lambda");
        expectColor(lam, "x", 0, "#aa0002", "lambda parameter");
        const kw = colorsOf(["if x then return 1 end"]);
        expectColor(kw, "return", 0, "#aa0004", "keyword");
    }

    // Deeply nested table constructors across lines: the state is carried from line to line, every
    // `{` gets the scope depth of its level, and after the last `}` we are back at the root.
    const checkNesting = function (name, lines, expectedMaxDepth)
    {
        let stack = vsctm.INITIAL;
        let depth = 0;
        let maxDepth = 0;
        const problems = [];
        lines.forEach(function (line, n)
        {
            const result = grammar.tokenizeLine(line, stack);
            stack = result.ruleStack;
            for (const token of result.tokens)
            {
                const text = line.slice(token.startIndex, token.endIndex);
                const level = token.scopes.filter(s => s == "meta.table.pluto").length;
                const last = token.scopes[token.scopes.length - 1];
                if (last == "punctuation.section.table.begin.pluto")
                {
                    ++depth;
                    maxDepth = Math.max(maxDepth, depth);
                    if (level != depth)
                    {
                        problems.push(`line ${n + 1}: "{" at col ${token.startIndex} has table depth ${level}, expected ${depth}`);
                    }
                }
                else if (last == "punctuation.section.table.end.pluto")
                {
                    if (level != depth)
                    {
                        problems.push(`line ${n + 1}: "}" at col ${token.startIndex} has table depth ${level}, expected ${depth}`);
                    }
                    --depth;
                }
                else if (text.trim() && level != depth)
                {
                    problems.push(`line ${n + 1}: "${text}" has table depth ${level}, expected ${depth}`);
                }
            }
        });
        if (depth != 0)
        {
            problems.push(`unbalanced: ${depth} table(s) still open at the end`);
        }
        if (maxDepth != expectedMaxDepth)
        {
            problems.push(`max depth ${maxDepth}, expected ${expectedMaxDepth}`);
        }
        if (problems.length)
        {
            console.log(name + " MISMATCH");
            console.log(problems.join("\n"));
            ok = false;
        }
    };
    checkNesting("nested tables: one line, 4 levels", [
        `local t = { 1, 2, { 3, 4, { 5, { 6 } } } }`,
        `print(t)`,
    ], 4);
    checkNesting("nested tables: 6 levels over many lines", [
        `local config = {`,
        `    name = "root",`,
        `    deep = {`,
        `        a = {`,
        `            b = {`,
        `                c = {`,
        `                    d = { value = 42, text = "x" },`,
        `                },`,
        `            },`,
        `        },`,
        `    },`,
        `    ["key with space"] = { [1] = { [2] = { [3] = true } } },`,
        `    fn = function(x: int): int`,
        `        return { inner = { x = x } }.inner.x`,
        `    end,`,
        `}`,
        `print(config.deep.a.b.c.d.value)`,
    ], 6);

    // Methods with an access modifier: `function` and the body are tokenized like any other function.
    const checkScopes = function (name, lines, wants)
    {
        let state = vsctm.INITIAL;
        const found = new Map();
        lines.forEach(function (line, n)
        {
            const r = grammar.tokenizeLine(line, state);
            state = r.ruleStack;
            for (const t of r.tokens)
            {
                found.set(n + ":" + line.slice(t.startIndex, t.endIndex).trim(), t.scopes);
            }
        });
        for (const [key, scope] of wants)
        {
            const scopes = found.get(key) || [];
            if (!scopes.includes(scope))
            {
                console.log(name + " MISMATCH: " + key + " wanted " + scope + ", got " + scopes.join(" > "));
                ok = false;
            }
        }
    };
    checkScopes("class with access modifiers", [
        `class Entity`,
        `    public function first()`,
        `        return self.hp`,
        `    end`,
        `end`,
        `public function get_health()`,
        `    return self.hp`,
        `end`,
        `private static function make(id: int): Entity`,
        `    return new Entity(id)`,
        `end`,
    ], [
        ["1:public", "storage.modifier.access.pluto"],
        ["1:function", "storage.type.function.pluto"],
        ["1:first", "entity.name.function.pluto"],
        ["2:return", "keyword.control.pluto"],
        ["2:self", "variable.language.self.pluto"],
        ["5:public", "storage.modifier.access.pluto"],
        ["5:function", "storage.type.function.pluto"],
        ["6:return", "keyword.control.pluto"],
        ["8:private", "storage.modifier.access.pluto"],
        ["8:static", "storage.modifier.pluto"],
        ["8:function", "storage.type.function.pluto"],
        ["9:return", "keyword.control.pluto"],
    ]);

    if (!ok)
    {
        process.exit(1);
    }
}

main();
