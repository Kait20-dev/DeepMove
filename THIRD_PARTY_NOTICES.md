# Сторонние компоненты

Корневая [MIT-лицензия](LICENSE) применяется к авторскому коду и документации
DeepMove. Она не заменяет лицензии зависимостей и сторонних материалов.
Точные версии установлены в lock-файлах соответствующих компонентов.

| Компонент | Использование | Лицензия и источник |
| --- | --- | --- |
| Next.js | Веб-приложение и сервер | [MIT](https://github.com/vercel/next.js/blob/canary/license.md) |
| React | Интерфейс арены | [MIT](https://github.com/facebook/react/blob/main/LICENSE) |
| chess.js | Правила и браузерная демонстрация | [BSD-2-Clause](https://github.com/jhlywa/chess.js/blob/master/LICENSE) |
| Stockfish.js / Stockfish | Локальный анализ завершённых партий | [GPL-3.0](https://github.com/nmrugg/stockfish.js) |
| python-chess / chess | Правила DeepMoveBot, DeepNeuroBot, DeepPatternBot и PGN-импорт | [GPL-3.0+](https://github.com/niklasf/python-chess/blob/master/LICENSE.txt) |
| Lucide | Иконки интерфейса | [ISC](https://github.com/lucide-icons/lucide/blob/main/LICENSE) |
| sharp | Обработка аватаров и иллюстраций сборки | [Apache-2.0](https://github.com/lovell/sharp/blob/main/LICENSE) |
| Marked | Сборка HTML-документации из Markdown | [MIT](https://github.com/markedjs/marked/blob/master/LICENSE.md) |

Полный перечень транзитивных зависимостей содержится в `package-lock.json`.
Сохраняй лицензионные файлы распространяемых компонентов. Отдельная
лицензия исходников DeepMove не разрешает распространять объединённую
сборку с GPL-компонентами с нарушением GPL.

Сборка Pages включает chess.js и его текст BSD-лицензии в `assets/licenses/`.
Она не включает Stockfish, Python-зависимости или серверную базу данных.

Логотипы КАИТ №20 и DeepMove используются как предоставленные материалы
проекта. Сторонние эмблемы не объявляются авторской программой по MIT.
