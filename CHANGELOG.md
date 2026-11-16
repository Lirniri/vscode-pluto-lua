# Changelog / История изменений

The history of earlier releases (0.15.4 – 0.29.7) and everything added since is gathered here in one release, **0.19.0**.
История прежних релизов (0.15.4 – 0.29.7) и всё добавленное после них собраны здесь в одном релизе **0.19.0**.

## English

### Highlighting and colors
- Highlight colors for functions, parameters, types, return types, keywords, operators, constants, modifiers and table braces by depth (`plua.highlight.*`); own colors for dark and light themes, color pickers, wrong values are never applied.
- Lambdas with typed parameters, multi-segment function names, `public` / `private` / `protected` before `function`; `demo-highlight.pluto` to tune colors on.

### Completion, hover, navigation
- Hover with the formatted function source, `@return` comments, exact chains, **Peek Code**; type hints with nullable types and unions; Outline, Go to Definition, signature help.
- English and Russian messages (`plua.language`).

### Diagnostics
- Pluto compiler errors and warnings (`plutoc -p -`), built-in checks (`require`, argument counts, `info.json`), JSON path checks with quick fixes, `.luaignore`.
- **Compilers tab** and `plua.compilers.list` (Add / Remove) for Pluto and Lua interpreters; a Lua syntax check.
- **Unknown types** (`plua.diagnostics.unknownTypes`), duplicate names, brackets that do not fit, functions that do not return what they say.

### Typing helpers
- Smart multi-line lists, new line after a comma, grey suggestions (`()`, ` = `, `then` / `do`, loops, `switch` / `case`, constructors), default values of parameters.
- Automatic `end`; smart delete keys (double Backspace / Delete on `end`, Shift + Backspace / Delete by pieces); these also work in Lua files.
- **Auto indent on Enter** (`plua.autoIndent.*`): empty lines inside blocks keep their indentation, indent after `case`, trim on save.
- **Keyboard layout fixer** (`plua.layoutFixer.*`, ru / uk / be to QWERTY): modes, profiles, `Э` / `э` open strings, fast typing and selections handled, command **Plua: Convert Keyboard Layout**.
- **Return helper** (`plua.returnHelper.*`): Enter after a typed header adds `return `; a bare `return` goes when the type is missing or wrong (also `function f() boo`, also after Ctrl+Z); the cursor moves behind `return ` when it rests (not while suggestions are open); `#return = x`.
- **Live directives** (`plua.liveDirectives.*`): `#target = value`, `>show_up`, `>show_down`, `>show_all`, `>type`, `>sign`, `>trace`, `>rename = name`, `>const`, `>unused`, `>calls`, also in comments (`-- #acc >type`); own prefix, separator and aliases; limits (`allowModify`, `skipConst`, `ignoredTargets`, search distance).

### Settings and commands
- Settings panel (**Plua: Settings**) with a tab for each group. All settings and commands use the `plua.*` prefix.
- **Breaking:** old `pluto.*` settings in `settings.json` are not read; rename them to `plua.*`. Command ids start with `plua.` and are shown as `Plua: ...`.

## Русский

### Подсветка и цвета
- Цвета подсветки функций, параметров, типов, типов возврата, ключевых слов, операторов, констант, модификаторов и скобок таблиц по глубине (`plua.highlight.*`); свои цвета для тёмной и светлой тем, выбор цвета, неверные значения не применяются.
- Лямбды с типами параметров, имена функций из нескольких частей, `public` / `private` / `protected` перед `function`; `demo-highlight.pluto` для настройки цветов.

### Автодополнение, подсказки, навигация
- Подсказка с отформатированным кодом функции, комментарии `@return`, точные цепочки, **Показать код**; подсказки типов с nullable и объединениями; Outline, переход к определению, подсказка сигнатуры.
- Сообщения на английском и русском (`plua.language`).

### Диагностика
- Ошибки и предупреждения компилятора Pluto (`plutoc -p -`), встроенные проверки (`require`, число аргументов, `info.json`), проверка путей в JSON с быстрыми исправлениями, `.luaignore`.
- Вкладка **Компиляторы** и `plua.compilers.list` (Добавить / Удалить) для интерпретаторов Pluto и Lua; проверка синтаксиса Lua.
- **Неизвестные типы** (`plua.diagnostics.unknownTypes`), повторяющиеся имена, не подходящие скобки, функции, которые возвращают не то, что заявлено.

### Помощники при наборе
- Умные многострочные списки, новая строка после запятой, серые подсказки (`()`, ` = `, `then` / `do`, циклы, `switch` / `case`, конструкторы), значения параметров по умолчанию.
- Автоматический `end`; умные клавиши удаления (двойной Backspace / Delete на `end`, Shift + Backspace / Delete по кусочкам); работают и в файлах Lua.
- **Автоотступы по Enter** (`plua.autoIndent.*`): пустые строки в блоках сохраняют отступ, отступ после `case`, очистка при сохранении.
- **Исправление раскладки** (`plua.layoutFixer.*`, ru / uk / be в QWERTY): режимы, профили, `Э` / `э` открывают строки, быстрый набор и выделение, команда **Plua: Преобразовать раскладку клавиатуры**.
- **Помощник по return** (`plua.returnHelper.*`): Enter после заголовка с типом добавляет `return `; пустой `return` удаляется, если типа нет или он неверный (в том числе `function f() boo`, в том числе после Ctrl+Z); курсор переходит за `return `, когда стоит неподвижно (не при открытых подсказках); `#return = x`.
- **Живые директивы** (`plua.liveDirectives.*`): `#цель = значение`, `>show_up`, `>show_down`, `>show_all`, `>type`, `>sign`, `>trace`, `>rename = имя`, `>const`, `>unused`, `>calls`, в том числе в комментариях (`-- #acc >type`); свой префикс, разделитель и алиасы; ограничения (`allowModify`, `skipConst`, `ignoredTargets`, дальность поиска).

### Настройки и команды
- Панель настроек (**Plua: Настройки**) с вкладкой для каждой группы. Все настройки и команды с префиксом `plua.*`.
- **Несовместимо:** старые настройки `pluto.*` в `settings.json` не читаются, переименуйте их в `plua.*`. Идентификаторы команд начинаются с `plua.`, в палитре они `Plua: ...`.
