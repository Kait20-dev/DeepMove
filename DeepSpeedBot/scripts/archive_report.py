"""Archive measured evidence compactly and regenerate the human-readable report."""
from __future__ import annotations
import argparse
import collections
import gzip
import hashlib
import json
import os
import platform
import shutil
import statistics
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--date",required=True,help="Date of measurement, YYYY-MM-DD")
    args=p.parse_args()
    source=ROOT/"reports"; target=ROOT/"docs/validation"
    target.mkdir(parents=True,exist_ok=True)
    bench=json.loads((source/"benchmark.json").read_text())
    matches=json.loads((source/"matches/summary.json").read_text())
    stress=json.loads((source/"stress/summary.json").read_text())
    arena=json.loads((source/"arena-smoke.json").read_text())
    for src,dst in (("benchmark.json","benchmark.json"),("matches/summary.json","matches-summary.json"),
                    ("matches/games.pgn","matches.pgn"),("stress/summary.json","stress-summary.json"),
                    ("stress/games.pgn","stress.pgn"),("arena-smoke.json","arena-smoke.json"),
                    ("arena-1.pgn","arena-1.pgn"),("arena-2.pgn","arena-2.pgn"),
                    ("arena-1.jsonl","arena-1.jsonl"),("arena-2.jsonl","arena-2.jsonl")):
        shutil.copyfile(source/src,target/dst)
    for name in ("matches","stress"):
        with (target/f"{name}-moves.jsonl.gz").open("wb") as output:
            with gzip.GzipFile(fileobj=output,mode="wb",mtime=0) as zipped:
                zipped.write((source/name/"moves.jsonl").read_bytes())
    binary=ROOT/"build"/("deepspeed.exe" if os.name=="nt" else "deepspeed")
    metadata={"date":args.date,"platform":platform.platform(),"cpu":"Intel Core Ultra 5 125H",
              "compiler":"GCC 16.2.0, C++20, -O3, generic x86-64, static MinGW runtime",
              "binary_bytes":binary.stat().st_size,"binary_sha256":hashlib.sha256(binary.read_bytes()).hexdigest(),
              "evidence_sha256":{path.name:hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(target.iterdir()) if path.is_file() and path.name!="manifest.json"}}
    (target/"manifest.json").write_text(json.dumps(metadata,indent=2)+"\n",encoding="utf-8")
    def load_moves(name): return [json.loads(line) for line in (source/name/"moves.jsonl").read_text().splitlines()]
    baseline_depths=collections.Counter(row["depth"] for row in load_moves("matches") if not row["native"])
    stress_depths=collections.Counter(row["depth"] for row in load_moves("stress") if not row["native"])
    table=[]
    for name,r in matches["totals"].items():
        table.append(f"| {name} | {r['win']}/{r['draw']}/{r['loss']} | {r['mean_plies']:.2f} | {r['median_move_ms']:.3f} | {r['ponder_hits']}/{r['ponder_opportunities']} |")
    stress_table=[]
    for name,r in stress["totals"].items():
        stress_table.append(f"| {name} | {r['win']}/{r['draw']}/{r['loss']} | {r['mean_plies']:.2f} | {r['median_move_ms']:.3f} | {r['ponder_hits']}/{r['ponder_opportunities']} |")
    latencies=[]
    for row in bench["cases"]:
        samples=row["samples"]
        latencies.append(f"| {row['case']} | {row['legal_moves']} | {row['median_ms']:.3f} | {row['max_ms']:.3f} | {statistics.median(s['nodes'] for s in samples):.0f} | {statistics.median(s['depth'] for s in samples):.0f} |")
    optimizations=[]
    for row in bench["optimizations"]:
        off=[s for s in row["samples"] if not s["enabled"]]; on=[s for s in row["samples"] if s["enabled"]]
        off_ms=sum(s["elapsed_ms"] for s in off); on_ms=sum(s["elapsed_ms"] for s in on)
        optimizations.append(f"| {row['feature']} | {off_ms:.3f} | {on_ms:.3f} | {(1-on_ms/off_ms)*100:.1f}% | {sum(s['nodes'] for s in off)} → {sum(s['nodes'] for s in on)} |")
    live=[]
    correlations=[]
    for index,r in enumerate(arena["games"],1):
        live.append(f"| {r['native_side']} | {r['result']} / {r['reason']} | {r['plies']} | {r['max_server_move_ms']} | {r['native_ponder_hits']}/{r['native_summary']['ponder_opportunities']} |")
        events=[json.loads(line) for line in (source/f"arena-{index}.jsonl").read_text().splitlines()]
        model=next(e for e in events if e["event"]=="model")
        correlations.append(f"партия {index}: r={model['complexity_correlation']:.3f}, n={model['observations']}, средний ответ {model['mean_ms']:.1f} мс")
    rss=max(row["peak_rss_bytes"] for row in bench["cases"])/1024/1024
    depthtext=", ".join(f"depth {d}: {n}" for d,n in sorted(baseline_depths.items()))
    stresstext=", ".join(f"depth {d}: {n}" for d,n in sorted(stress_depths.items()))
    report=f"""# Проверка DeepSpeedBot — {args.date}

Проверено локально на **Intel Core Ultra 5 125H, Windows x64**, GCC 16.2.0 из переносимого w64devkit, C++20, Release `-O3`, без `-march=native`. Нативный процесс в бенчмарках и матчах привязан к одному разрешённому логическому CPU. Python baseline — один поисковый поток под планировщиком ОС; идентичность физических ядер не доказывается. Это локальные измерения, не официальный турнир, не Elo и не тесты на стандартизированном турнирном железе.

Исходные цифры, полные PGN и сжатые логи ходов лежат в [validation](validation/manifest.json). Размер готового EXE — {metadata['binary_bytes']/1024/1024:.2f} МиБ; максимальный измеренный RSS нативного процесса — **{rss:.1f} МиБ** при Hash=32. RSS включает код/стек/runtime и не равен только размеру TT. RSS Python-клиента здесь не измерялся. Компилятор для запуска готового EXE не нужен.

## Функциональность

Пройдены **5485 native checks**, в том числе initial perft depths 1–5: 20 / 400 / 8902 / 197281 / 4865609; Kiwipete 1–4: 48 / 2039 / 97862 / 4085603; сложный en passant perft4: 43238. Проверены точность make/unmake и Zobrist, история повторений в TT, рокировки, все превращения, связанное взятие на проходе, мат, пат, недостаточный материал и 50 ходов.

**15 Python integration tests** прошли для живого C++-процесса и адаптера: все пять режимов выбирают мат; multi-branch hit возвращает подготовленный ход с нулём новых узлов; rapid hit/miss и THINK/PONDER переключения не ждут окончания старого бюджета; проверены UCI ponderhit/stop, earliest-of-time/depth/nodes limits, жёсткий бюджет и перезапуск. При выключенном LMR TT сохраняет одинаковые fixed-depth scores на контрольных позициях. HTTP-тесты проверяют HTTPS/redirect/токен, нелегальный вывод и обязательный GET после потерянного ответа на POST.

Независимый oracle python-chess: **200 случайных легальных позиций**, точные множества ходов и **203723 perft2 узла** совпали. Библиотека используется только арбитром/тестом, не ядром или production-коннектором.

Регрессия существующего проекта: 25 тестов арены, 27 тестов DeepMoveBot, TypeScript, ESLint и Next.js production build проходят. CMake dependency-файлы `compiler_depend.ts` исключены из TS-сканирования вместе с отдельным C++-проектом. Подготовлен CI Windows/MSVC и Linux/GCC с ASan/UBSan; **удалённый CI и Linux локально ещё не запускались**.

## Латентность

Пять запусков каждой позиции с холодной TT. Адаптивный режим, 300 секунд остатка, hard=2780 мс. В таблице нативный search elapsed, не весь HTTP/IPC. В JSON есть roundtrip_ms, nodes, NPS, TT hits и память каждого запуска.

| Позиция | Легальных | Медиана, мс | Максимум, мс | Медиана узлов | Глубина |
| --- | ---: | ---: | ---: | ---: | ---: |
{chr(10).join(latencies)}

`forced` действительно имеет один легальный ход. `tactical_mate` завершается после нахождения мата. Нормальные позиции укладываются в десятки миллисекунд; wide получает увеличенный критический бюджет. Цифры зависят от ОС, CPU, температуры, нагрузки и глубины.

## Измеримый эффект оптимизаций

Три одинаковые позиции, холодная TT, полностью завершённая depth=4. Остальные параметры сохраняются. Это микробенчмарк, не доказательство игрового усиления; LMR — выборочное сокращение поиска и может менять оценку относительно полного перебора.

| Функция | Выключена, суммарно мс | Включена, мс | Снижение времени | Узлы off → on |
| --- | ---: | ---: | ---: | ---: |
{chr(10).join(optimizations)}

Ассемблер, magic bitboards и SIMD не добавлялись: для них измеримого выигрыша в этой реализации не установлено.

## Основная серия — 64 локальные партии

Восемь вариантов × восемь игр против **неизменённого DeepMoveBot**; чередуются цвета и четыре начальные последовательности. Seed=20261115. Поиск каждому целится в 20 мс, общий запас 300 секунд, собственный ход до 3 секунд. Pondering разрешён нативному боту; baseline его не реализует. Это преднамеренная проверка возможностей, не сравнение при одинаковом числе CPU-инструкций. Максимум 240 полуходов; незавершённые не превращаются в ничьи.

| Вариант | W/D/L | Средние полуходы | Медиана поиска, мс | Ponder hits/opportunities |
| --- | ---: | ---: | ---: | ---: |
{chr(10).join(table)}

Все 64 партии закончились матом; нет незавершённых, таймаутов или побед по времени. Но baseline на 20 мс слишком слаб для подтверждения силы стиля: **{depthtext}**. Глубина 0 означает, что он использовал свой легальный fallback без завершения первого уровня. Поэтому 64/64 нельзя превращать в вывод о турнирной силе, качестве сложности или превосходстве над современными движками. C++ и Python имеют разную скорость, а OS scheduling делает результаты time-based поиска невоспроизводимыми до хода даже при фиксированном seed.

## Дополнительная серия — 8 партий против более долгого поиска

Native target=70 мс, DeepMoveBot target=200 мс, четыре игры с pondering и четыре без, цвета и два дебютных начала попарно совпадают. Настройки/все результаты сохранены в stress-summary.json и stress.pgn.

| Вариант | W/D/L | Средние полуходы | Медиана поиска, мс | Ponder hits/opportunities |
| --- | ---: | ---: | ---: | ---: |
{chr(10).join(stress_table)}

Завершённые глубины baseline: **{stresstext}**. Все восемь партий закончились матом, побед и поражений по времени нет. Выборка мала; победы в обеих группах не позволяют утверждать, что pondering увеличил вероятность победы. Увеличенный бюджет снижает, но не устраняет ограниченность учебного соперника.

## Настоящий API DeepMove — две полные партии

Отдельный production Next.js на 127.0.0.1:3127, отдельная SQLite, два аккаунта, настоящие bearer-ключи, ready/countdown, custom **300+0 / 3 секунды на ход**. DeepSpeedBot с адаптивным временем, DeepMoveBot максимум 120 мс. Это проверка совместимости и дедлайнов, не strength match при равных бюджетах. Партии не обрезаны и не присуждены тестом.

| Цвет DeepSpeedBot | Результат / причина | Полуходы | Максимум серверного elapsed у обоих, мс | Native ponder hit |
| --- | --- | ---: | ---: | ---: |
{chr(10).join(live)}

Просрочек нет. Проверено, что публичные снимки не раскрывают ключи. PGN получены именно от сервера. Большая серия не гоняется через рабочий API: у него 20 созданий/час на аккаунт; локальный арбитр не обходит эту защиту.

## Что показала гипотеза сложности

Реальные наблюдения в API: {'; '.join(correlations)}. Эти корреляции смешивают фазу, шахи, фиксированный max-think baseline, polling и сеть. Число наблюдений мало. Нельзя считать C доказанным предсказателем стоимости поиска произвольного соперника.

**Подтверждено:** легальность, полные игры, сохранение процесса/TT, полезные prepared replies, быстрый hit, безопасный miss, работа без времени на pondering, соблюдение проверенных бюджетов и меньше узлов/времени от TT/LMR в микробенчмарке.

**Не подтверждено:** рост вероятности победы от бонуса сложности/избегания разменов; выигрыш именно по времени; превосходство отдельных режимов; перенос цифр на турнирное железо. Pondering в данных экономит время некоторых ответов, но 100% W/L в слабом baseline делает win-rate нечувствительным. Нет оснований поднимать коэффициенты или намеренно ухудшать шахматную позицию ради длины партии. Мат всегда предпочтительнее затягивания.

Для следующего исследования нужен более сильный авторский baseline, адаптивные бюджеты, больше независимых пар партий, контроль физических CPU и заранее выбранная метрика побед, а не только длина. Включать намеренные сетевые задержки или мешать процессу противника запрещено и здесь не реализовано.

## Повторить

Команды сборки/тестов — в [README](../README.md). `scripts/benchmark.py` обновляет замеры; `scripts/matches.py --games-per-variant 8` — 64 матча; дополнительная серия:

```sh
python DeepSpeedBot/scripts/matches.py --variants balanced no_ponder --games-per-variant 4 --think-ms 70 --baseline-ms 200 --output DeepSpeedBot/reports/stress
node DeepSpeedBot/scripts/arena-smoke.mjs
python DeepSpeedBot/scripts/archive_report.py --date YYYY-MM-DD
```

Для matches.py используется Python с установленным test-only chess и исходниками DeepMoveBot, как описано в README. `docs/validation/*-moves.jsonl.gz` распаковывается стандартным gzip/Python, без дополнительной утилиты. Проверки SHA-256 исходных артефактов и текущего EXE — manifest.json. Сам EXE и временные инструменты не коммитятся.
"""
    (ROOT/"docs/VALIDATION.md").write_text(report,encoding="utf-8")
    print(f"Archived {len(list(target.iterdir()))} files, report regenerated: {target}")


if __name__=="__main__": main()
