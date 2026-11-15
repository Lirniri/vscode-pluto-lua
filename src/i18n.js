// Localization of the messages of the extension (English and Russian).
// Free of VS Code dependencies: the language is chosen with `setLanguage`, see `resolveLanguage`.
// The names and descriptions of settings and commands live in package.nls.json / package.nls.ru.json;
// VS Code picks those by its own display language.

"use strict";

/** @type {Record<"en"|"ru", Record<string, string>>} */
const MESSAGES = {
	en: {
		"cmd.openScript": "Open a Pluto script first.",
		"task.run": "Pluto: Run Script",
		"task.lint": "Pluto: Lint Script",
		"status.indexing": "Pluto: indexing workspace…",
		"status.indexed": "Pluto: indexed {0} files, {1} module manifests",
		"status.excluded": ", {0} excluded",

		"hover.line": "Line {0}",
		"hover.manifest": "Manifest:",
		"hover.file": "File:",
		"hover.requires": "Requires `local {0} = require \"pluto:{0}\"`",
		"label.module": "(module)",
		"label.builtinModule": "(built-in module)",
		"label.library": "(library)",
		"label.keyword": "(keyword)",
		"label.type": "(type)",
		"label.nullableType": "(nullable type)",
		"completion.module": "module",
		"completion.builtinModule": "built-in module",
		"nullable.text": "Can be `{0}` or `nil` (optional / nullable)",
		"union.label": "(union type)",
		"union.labelNil": "(union type that allows nil)",
		"union.text": "The value can be one of these types:",
		"union.sameAs": "Same as `{0}?`.",
		"colors.problem.invalid": "{0}: \"{1}\" is not a valid color or style, so it is skipped and the color of the theme stays.",
		"colors.problem.transparent": "{0}: \"{1}\" is fully transparent, the text would be invisible, so it is skipped and the color of the theme stays.",
		"colors.problem.unknownKey": "pluto.highlight.colors: unknown key \"{0}\" (\"{1}\") is ignored. Known keys: {2}.",
		"colors.openSettings": "Open settings",
		"declarations.showAll": "Show all declarations ({0})",
		"declarations.showAllTooltip": "Open the list of all declarations",
		"hover.peekCode": "Peek Code",
		"hover.peekCodeTooltip": "Open the code in a peek window",
		"body.truncated": "-- ... (+{0} lines)",

		"builtin.returns": "Returns:",
		"builtin.aliases": "Aliases:",
		"builtin.overloaded": "*The parameters of this function depend on the mode; see the Pluto documentation.*",

		"type.int": "Integer number, a subtype of `number`.",
		"type.integer": "Integer number, a subtype of `number`.",
		"type.number": "Number: an integer or a floating-point number.",
		"type.float": "Floating-point number, a subtype of `number`.",
		"type.string": "Immutable sequence of bytes. String values have the methods of the `string` library, e.g. `s:upper()`.",
		"type.bool": "Boolean: `true` or `false`.",
		"type.boolean": "Boolean: `true` or `false`.",
		"type.table": "Table: associative array, the only data structure of Pluto/Lua. See the `table` library.",
		"type.function": "Function or callable value.",
		"type.userdata": "Userdata: a value managed by the host application or a C library.",
		"type.thread": "Coroutine.",
		"type.nil": "The absence of a value.",
		"type.void": "No return value.",
		"type.any": "Any type.",
		"type.mixed": "Any type.",

		"lint.missingModule": "Module '{0}' not found: no matching .pluto or .lua file in the workspace.",
		"lint.missingArgs.one": "'{0}' expects at least {1} argument but got {2}.",
		"lint.missingArgs.many": "'{0}' expects at least {1} arguments but got {2}.",
		"lint.required": " Required: {0}.",
		"manifest.idEmpty": "'id' must be a non-empty string.",
		"manifest.idMissing": "Missing required field 'id'.",
		"manifest.entryType": "'{0}' must be a path to a .pluto or .lua file.",
		"manifest.entryMissing": "Entry file '{0}' does not exist.",
		"manifest.depsType": "'dependencies' must be an array of module ids.",
		"manifest.depUnknown": "Unknown dependency '{0}': no info.json with this id in the workspace.",

		"compiler.notExecutable": "pluto.diagnostics.compilerPath points to '{0}', which is not an executable file. Falling back to automatic detection.",
		"diag.untrusted": "Workspace is not trusted: the Pluto compiler is not used, only built-in checks run.",
		"diag.using": "Using Pluto compiler {0} ({1}).",
		"diag.source.setting": "from pluto.diagnostics.compilerPath",
		"diag.source.workspace": "found in the workspace",
		"diag.source.path": "found on PATH",
		"diag.none": "No Pluto compiler found (pluto.diagnostics.compilerPath, workspace, PATH): only built-in checks run.",
		"diag.luaUsing": "Checking .lua files with {0} ({1}).",
		"diag.luaNone": "No Lua interpreter found (pluto.lua.compilerPath, bin/lua of the workspace, PATH): .lua files get only the built-in checks.",
		"json.pathMissing": "File '{0}' not found (looked next to this JSON file and in the workspace folder).",
		"json.pathMissingNoFolder": "File '{0}' not found next to this JSON file.",
		"json.pathMissingMoved": "File '{0}' not found. Did you mean '{1}'?",
		"json.replaceWith": "Replace with '{0}'",
		"json.noFolder": "Pluto: no folder is open. Paths of files in a JSON file are only checked next to it; the hints \"did you mean ...\" need an open project folder.",
		"json.openFolder": "Open folder",
		"json.moreInfo": "Details",
		"json.dontShow": "Don't show again",
		"diag.failedToRun": "Failed to run {0}: {1}. The compiler is disabled until settings change.",
		"diag.timeout": "Pluto compiler timed out on {0}.",
		"diag.exitCode": "Pluto compiler exited with code {0} without a recognizable message:\n{1}",
	},
	ru: {
		"cmd.openScript": "Сначала откройте скрипт Pluto.",
		"task.run": "Pluto: запуск скрипта",
		"task.lint": "Pluto: проверка скрипта",
		"status.indexing": "Pluto: индексация рабочей области…",
		"status.indexed": "Pluto: проиндексировано файлов — {0}, манифестов модулей — {1}",
		"status.excluded": ", исключено — {0}",

		"hover.line": "Строка {0}",
		"hover.manifest": "Манифест:",
		"hover.file": "Файл:",
		"hover.requires": "Нужен `local {0} = require \"pluto:{0}\"`",
		"label.module": "(модуль)",
		"label.builtinModule": "(встроенный модуль)",
		"label.library": "(библиотека)",
		"label.keyword": "(ключевое слово)",
		"label.type": "(тип)",
		"label.nullableType": "(допускающий nil)",
		"completion.module": "модуль",
		"completion.builtinModule": "встроенный модуль",
		"nullable.text": "Может быть `{0}` или `nil` (необязательное значение)",
		"union.label": "(объединение типов)",
		"union.labelNil": "(объединение, допускающее nil)",
		"union.text": "Значение может быть одним из типов:",
		"union.sameAs": "То же, что `{0}?`.",
		"colors.problem.invalid": "{0}: «{1}» — не цвет и не стиль, поэтому значение пропущено и остаётся цвет темы.",
		"colors.problem.transparent": "{0}: «{1}» полностью прозрачен, текст стал бы невидимым, поэтому значение пропущено и остаётся цвет темы.",
		"colors.problem.unknownKey": "pluto.highlight.colors: неизвестный ключ «{0}» («{1}») игнорируется. Допустимые ключи: {2}.",
		"colors.openSettings": "Открыть настройки",
		"declarations.showAll": "Показать все объявления ({0})",
		"declarations.showAllTooltip": "Открыть список всех объявлений",
		"hover.peekCode": "Показать код",
		"hover.peekCodeTooltip": "Открыть код во встроенном окне",
		"body.truncated": "-- ... (+{0} строк)",

		"builtin.returns": "Возвращает:",
		"builtin.aliases": "Псевдонимы:",
		"builtin.overloaded": "*Параметры этой функции зависят от режима; см. документацию Pluto.*",

		"type.int": "Целое число, подтип `number`.",
		"type.integer": "Целое число, подтип `number`.",
		"type.number": "Число: целое или с плавающей точкой.",
		"type.float": "Число с плавающей точкой, подтип `number`.",
		"type.string": "Неизменяемая последовательность байтов. У строк есть методы библиотеки `string`, например `s:upper()`.",
		"type.bool": "Логический тип: `true` или `false`.",
		"type.boolean": "Логический тип: `true` или `false`.",
		"type.table": "Таблица: ассоциативный массив, единственная структура данных Pluto/Lua. См. библиотеку `table`.",
		"type.function": "Функция или вызываемое значение.",
		"type.userdata": "Userdata: значение, которым управляет приложение-хозяин или C-библиотека.",
		"type.thread": "Корутина.",
		"type.nil": "Отсутствие значения.",
		"type.void": "Нет возвращаемого значения.",
		"type.any": "Любой тип.",
		"type.mixed": "Любой тип.",

		"lint.missingModule": "Модуль '{0}' не найден: в рабочей области нет подходящего файла .pluto или .lua.",
		"lint.missingArgs.one": "'{0}' ожидает минимум аргументов: {1}, передано: {2}.",
		"lint.missingArgs.many": "'{0}' ожидает минимум аргументов: {1}, передано: {2}.",
		"lint.required": " Обязательные: {0}.",
		"manifest.idEmpty": "'id' должен быть непустой строкой.",
		"manifest.idMissing": "Отсутствует обязательное поле 'id'.",
		"manifest.entryType": "'{0}' должен быть путём к файлу .pluto или .lua.",
		"manifest.entryMissing": "Файл точки входа '{0}' не существует.",
		"manifest.depsType": "'dependencies' должен быть массивом идентификаторов модулей.",
		"manifest.depUnknown": "Неизвестная зависимость '{0}': в рабочей области нет info.json с таким id.",

		"compiler.notExecutable": "pluto.diagnostics.compilerPath указывает на '{0}', это не исполняемый файл. Используется автоматический поиск.",
		"diag.untrusted": "Рабочая область не является доверенной: компилятор Pluto не используется, работают только встроенные проверки.",
		"diag.using": "Используется компилятор Pluto {0} ({1}).",
		"diag.source.setting": "из pluto.diagnostics.compilerPath",
		"diag.source.workspace": "найден в рабочей области",
		"diag.source.path": "найден в PATH",
		"diag.none": "Компилятор Pluto не найден (pluto.diagnostics.compilerPath, рабочая область, PATH): работают только встроенные проверки.",
		"diag.luaUsing": "Файлы .lua проверяются с помощью {0} ({1}).",
		"diag.luaNone": "Интерпретатор Lua не найден (pluto.lua.compilerPath, bin/lua рабочей области, PATH): для файлов .lua работают только встроенные проверки.",
		"json.pathMissing": "Файл '{0}' не найден (искали рядом с этим JSON и в папке рабочей области).",
		"json.pathMissingNoFolder": "Файл '{0}' не найден рядом с этим JSON.",
		"json.pathMissingMoved": "Файл '{0}' не найден. Возможно, вы имели в виду '{1}'?",
		"json.replaceWith": "Заменить на '{0}'",
		"json.noFolder": "Pluto: папка не открыта. Пути к файлам в JSON проверяются только рядом с ним; подсказки «возможно, вы имели в виду …» работают при открытой папке проекта.",
		"json.openFolder": "Открыть папку",
		"json.moreInfo": "Подробнее",
		"json.dontShow": "Больше не показывать",
		"diag.failedToRun": "Не удалось запустить {0}: {1}. Компилятор отключён до изменения настроек.",
		"diag.timeout": "Компилятор Pluto не уложился во время при проверке {0}.",
		"diag.exitCode": "Компилятор Pluto завершился с кодом {0} без понятного сообщения:\n{1}",
	},
};

/** @type {"en"|"ru"} */
let current = "en";

/**
 * Picks the language: a fixed `en`/`ru` from the setting, or, for `auto`, Russian if the editor's
 * display language is Russian (`ru`, `ru-RU`, `ru_RU`) and English for everything else.
 * @param {string|undefined} setting Value of `pluto.language`.
 * @param {string|undefined} envLanguage `vscode.env.language`.
 * @returns {"en"|"ru"}
 */
function resolveLanguage(setting, envLanguage)
{
	if (setting == "en" || setting == "ru")
	{
		return setting;
	}
	return /^ru(?:[-_]|$)/i.test(String(envLanguage || "")) ? "ru" : "en";
}

/** @param {"en"|"ru"|string} language */
function setLanguage(language)
{
	current = language == "ru" ? "ru" : "en";
}

/** @returns {"en"|"ru"} */
function getLanguage()
{
	return current;
}

/**
 * The message in the current language, with `{0}`, `{1}`… replaced by the arguments.
 * A missing translation falls back to English, then to the key itself.
 * @param {string} key
 * @param {...(string|number)} args
 */
function t(key, ...args)
{
	const text = MESSAGES[current][key] !== undefined ? MESSAGES[current][key] : (MESSAGES.en[key] !== undefined ? MESSAGES.en[key] : key);
	return text.replace(/\{(\d+)\}/g, (match, index) => args[Number(index)] !== undefined ? String(args[Number(index)]) : match);
}

module.exports = { MESSAGES, resolveLanguage, setLanguage, getLanguage, t };
