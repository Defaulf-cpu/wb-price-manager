# Спецификация стратегий Indeepa 2.0 — для переноса в собственный репрайсер

> Документ собран по: реальным JSON-стратегиям, сохранённым из интерфейса Indeepa; списку выражений
> («исходных показателей») из интерфейса; отчёту `RP-OZ_INPUT_REPORT_COMPILER_REPORT.csv`;
> текстовым логам правил из истории пересчёта; сообщениям об ошибках тест-выражений Indeepa (там
> виден сгенерированный ClickHouse-SQL — это самый ценный источник по семантике).
>
> Всё, что помечено **[ПОДТВЕРЖДЕНО]** — видно в реальных файлах/логах.
> Всё, что помечено **[ГИПОТЕЗА]** — рабочее предположение, требует проверки на своём репрайсере / в UI.

---

## 0. TL;DR для разработчика

1. Стратегия = **набор правил (rules)**. Правила проверяются **строго сверху вниз**, срабатывает
   **первое подходящее**, остальные игнорируются. Это подтверждено сгенерированным SQL:
   `arrayFirst(a -> coalesce(a,-1) > 0, [if(cond1, expr1, NULL), if(cond2, expr2, NULL), ...])`.
2. У каждого правила есть **условия** (`conditions`) и **как считать новую цену** (`priceCalcConfig`).
3. Новую цену считают из **одного исходного показателя** (`inputFieldAlias`) плюс «тип изменения»
   (`changeType`: увеличить / уменьшить / установить) и «в чём изменение» (`valueType`: рубли / проценты).
4. После расчёта цена **зажимается** в коридор `[мин. порог; макс. порог]` товара (в Indeepa это
   `Расчетная мин цена` / `Расчетная базовая цена` и их варианты по карте Ozon).
5. Пересчёт в Indeepa идёт **не каждые 10 минут, а примерно раз в 40 минут** (факт от пользователя).

---

## 1. Общая модель цены в Ozon (важно понять до кода)

У товара в Indeepa одновременно живёт несколько «цен». Именно из-за этого возникает путаница
«в истории показывает 5932, а цена стала 5697».

| Слой | Поле в отчёте | Alias | Что это |
|---|---|---|---|
| Цена до скидки | `Текущая цена до скидки`, `PriceBeforeDisc` | `OZONCurrentPriceBeforeDiscount`, `PriceBeforeDisc` | цена, которую продавец «объявляет» |
| Базовая (действующая) | `Действующая базовая цена` | `BasePrice` | цена после скидки продавца, до СПП |
| Без СПП | `Текущая цена без СПП` | `OZONCurrentRetailPrice` | цена на витрине без СПП |
| С СПП | `Текущая цена с СПП` | `OZONCurrentRetailtPriceWithSpp` | с учётом СПП Ozon |
| По карте Ozon | `Цена по карте Ozon` | `OzonCardPrice` | с учётом скидки по карте Ozon (`OzonCardPercent`) |
| Цена по стратегии | `Цена по стратегии` / `StrategyPrice` | `StrategyPrice` | что посчитала стратегия (до применения) |
| CalcPrice | `CalcPrice` | `CalcPrice` | внутренняя расчётная цена движка |

Пороги («коридор»), которые задаёт пользователь в настройках товара:

| Отчёт | Alias | Смысл |
|---|---|---|
| `Расчетная мин цена` | `CalcMinPrice` | **нижний порог** (в базовой цене) |
| `Расчетная базовая цена` | `CalcMaxPrice` | **верхний порог** (в базовой цене) |
| `Мин цена по карте (все размеры)` | `CalcMinPriceOzonCardBySize` | нижний порог по карте Ozon |
| `Макс цена по карте (все размеры)` | `CalcMaxPriceOzonCardBySize` | верхний порог по карте Ozon |
| `Мин цена с СПП (все размеры)` | `CalcMinPriceWithSppBySize` | нижний порог с СПП |
| `Макс цена с СПП (все размеры)` | `CalcMaxPriceWithSppBySize` | верхний порог с СПП |

Пороги считаются из **себестоимости + расходов + мин./макс. маржи** из настроек
(`MinMarginAmountSetting`, `MinMarginPercentSetting`, `MaxMarginAmountSetting`, `MaxMarginPercentSetting`,
`RecommendedRetailPriceSetting`, `AcquiringPercent`, `RelativeCostsFbo/Fbs`, `AbsolutCostsFbo/Fbs`, `StorageCosts` и т.д.).

**Правило для переноса:** в своём репрайсере держи три коридора отдельно — базовый, по карте, с СПП.
Стратегия считает **одну** цену, а применяется она к тому слою, к которому относится исходный показатель.

---

## 2. Структура JSON стратегии

Пример (упрощённый, структура реальная — из `Конкурент  цикл СПП.json`):

```json
{
  "name": "Конкурент + цикл СПП",
  "formula": "",
  "addCosts": false,
  "ignoreMaximums": false,
  "disableStdFormulas": null,
  "testDataRows": [
    {
      "inputs": {
        "SumStock": "5",
        "CompetitorPrice": "0",
        "CalcMinPriceStopCicleBaseExtV2": "null",
        "expectedValue": "null"
      },
      "expectedValue": "null"
    }
  ],
  "type": 1,
  "rules": [
    {
      "name": "Следование за конкурентом",
      "conditions": [
        {
          "isOr": false,
          "elements": [
            {
              "leftExpressionType": 10,
              "leftExpression": "SumStock",
              "compareOperator": 70,
              "rightExpressionType": 0,
              "rightExpression": "0",
              "rightExpression2": ""
            },
            {
              "leftExpressionType": 10,
              "leftExpression": "CompetitorPrice",
              "compareOperator": 70,
              "rightExpressionType": 0,
              "rightExpression": "9",
              "rightExpression2": null
            }
          ],
          "children": []
        }
      ],
      "priceCalcConfig": {
        "priceCalcExpression": null,
        "priceCalcExpressionConfig": {
          "inputFieldAlias": "CompetitorPrice",
          "changeType": 30,
          "valueType": 0,
          "changeAmount": 0
        },
        "useConfig": true
      },
      "enabled": false,
      "schedule": null
    }
  ],
  "schedule": null,
  "enabled": true
}
```

### 2.1 Поля верхнего уровня

| Поле | Тип | Смысл | Статус |
|---|---|---|---|
| `name` | string | Имя стратегии | **[ПОДТВЕРЖДЕНО]** |
| `formula` | string | Произвольная формула стратегии (обычно `""`) | **[ПОДТВЕРЖДЕНО]** что поле есть; синтаксис неизвестен |
| `addCosts` | bool | «Добавлять расходы» при расчёте цены | **[ПОДТВЕРЖДЕНО]** что поле есть; точная семантика — **[ГИПОТЕЗА]** |
| `ignoreMaximums` | bool | Игнорировать максимальные пороги (верхнюю границу коридора) | **[ПОДТВЕРЖДЕНО]** что поле есть |
| `disableStdFormulas` | null/bool | Отключить стандартные формулы/доводку движка | **[ПОДТВЕРЖДЕНО]** что поле есть |
| `testDataRows` | array | Тестовые входные данные для кнопки «Тест» в UI. Формат: `{"inputs": {Alias: "значение", ..., "expectedValue": ...}, "expectedValue": ...}`. Значения — **строками** | **[ПОДТВЕРЖДЕНО]** |
| `type` | int | Площадка/тип стратегии. `1` — Ozon (все рабочие файлы с `type: 1`) | **[ГИПОТЕЗА]** что 2 = WB |
| `rules` | array | Список правил, **порядок = приоритет** (первое сверху побеждает) | **[ПОДТВЕРЖДЕНО]** |
| `schedule` | null/object | Расписание работы всей стратегии (`null` = круглосуточно) | **[ПОДТВЕРЖДЕНО]** что поле есть |
| `enabled` | bool | Включена ли стратегия | **[ПОДТВЕРЖДЕНО]** |

### 2.2 Правило (`rules[]`)

| Поле | Тип | Смысл |
|---|---|---|
| `name` | string | Имя правила. **Именно оно попадает в текст истории**: `Правило стратегии: <name>: >>значение<<` |
| `conditions` | array | Массив **групп** условий |
| `priceCalcConfig` | object | Как считать новую цену |
| `enabled` | bool | Включено ли правило |
| `schedule` | null/object | Расписание конкретного правила (`null` = всегда) |

### 2.3 Группа условий (`conditions[]`)

```json
{ "isOr": false, "elements": [ {...}, {...} ], "children": [ ... ] }
```

| Поле | Смысл | Статус |
|---|---|---|
| `isOr` | `false` = все элементы через **И**; `true` = через **ИЛИ** | **[ПОДТВЕРЖДЕНО]** (в UI видно «И»/«ИЛИ», пример со скриншота: `Сумма остатков > 3 И Заказы сегодня > 28`) |
| `elements` | список простых сравнений | **[ПОДТВЕРЖДЕНО]** |
| `children` | вложенные группы условий (для скобок) | **[ПОДТВЕРЖДЕНО]** что массив есть |

### 2.4 Простое сравнение (`elements[]`)

```json
{
  "leftExpressionType": 10,
  "leftExpression": "QtyTodayBaseExt",
  "compareOperator": 70,
  "rightExpressionType": 0,
  "rightExpression": "24",
  "rightExpression2": null
}
```

| Поле | Смысл |
|---|---|
| `leftExpressionType` | тип левой части. `10` = **поле/выражение** (alias из словаря) **[ПОДТВЕРЖДЕНО]** |
| `leftExpression` | сам alias, если тип 10 |
| `compareOperator` | код оператора сравнения, см. §3 |
| `rightExpressionType` | тип правой части. `0` = **константа** **[ПОДТВЕРЖДЕНО]**; должен быть ещё тип «поле» — **[ГИПОТЕЗА]**, требует выяснения (см. §7) |
| `rightExpression` | значение/alias правой части |
| `rightExpression2` | второе значение. Встречается `""` и `null`; вероятно, для операторов «между»/«в диапазоне» — **[ГИПОТЕЗА]** |

### 2.5 Расчёт цены (`priceCalcConfig`)

```json
"priceCalcConfig": {
  "priceCalcExpression": null,
  "priceCalcExpressionConfig": {
    "inputFieldAlias": "CompetitorPriceOzonCard_BaseExt",
    "changeType": 20,
    "valueType": 10,
    "changeAmount": 3
  },
  "useConfig": true
}
```

| Поле | Смысл | Статус |
|---|---|---|
| `useConfig` | `true` = использовать «конструктор» (`priceCalcExpressionConfig`); `false` = использовать произвольное выражение `priceCalcExpression` | **[ГИПОТЕЗА]** (логично и подтверждается тем, что во всех реальных файлах `useConfig: true`, а `priceCalcExpression: null`) |
| `priceCalcExpression` | строка произвольного выражения (генерируется в ClickHouse-SQL, см. §4) | **[ПОДТВЕРЖДЕНО]** что движок умеет произвольные выражения |
| `inputFieldAlias` | **исходный показатель** — от чего считаем новую цену | **[ПОДТВЕРЖДЕНО]** |
| `changeType` | как менять: `10` увеличить, `20` уменьшить, `30` установить | **[ПОДТВЕРЖДЕНО]** |
| `valueType` | в чём: `0` рубли, `10` проценты | **[ПОДТВЕРЖДЕНО]** |
| `changeAmount` | величина изменения. **Всегда положительная**; направление задаёт `changeType` | **[ПОДТВЕРЖДЕНО]** (баг с двойным минусом, см. §6.4) |

---

## 3. Коды (`enum`-ы)

### 3.1 `compareOperator`

| Код | Значение | Статус |
|---|---|---|
| `70` | `>` (больше) | **[ПОДТВЕРЖДЕНО]** — из JSON + сгенерированный SQL `(SumStock > 3)` |
| `30` | `LIKE` / «содержит» | **[ПОДТВЕРЖДЕНО]** ошибкой `Illegal type Float64 of argument of function like ... Percent_plan_Period LIKE '%100%'` |

Остальные операторы (`=`, `!=`, `<`, `>=`, `<=`, «между») в реальных файлах не встречались.
**Как быстро выяснить любые коды:** создать в UI правило с нужным оператором, сохранить стратегию,
скачать её JSON и посмотреть код. Это 2 минуты на оператор и полностью закрывает вопрос.

> ⚠️ Практический вывод: не пытайтесь делать «диапазоны» через `LIKE`. В Indeepa это математически
> ломается (LIKE к Float64). Диапазон = **два правила** сверху вниз по убыванию порога, потому что
> первое подходящее правило побеждает.

### 3.2 `leftExpressionType` / `rightExpressionType`

| Код | Значение | Статус |
|---|---|---|
| `10` | поле/выражение (alias) | **[ПОДТВЕРЖДЕНО]** |
| `0` | константа | **[ПОДТВЕРЖДЕНО]** |

### 3.3 `changeType`

| Код | Смысл | Формула (из сгенерированного SQL) |
|---|---|---|
| `10` | **Увеличение** | `X * (1 + amount/100)` при `valueType:10` **[ПОДТВЕРЖДЕНО]** |
| `20` | **Уменьшение** | `X * (1 - amount/100)` при `valueType:10` **[ПОДТВЕРЖДЕНО]** |
| `30` | **Установить / следовать** | просто `X` (при `valueType:0, changeAmount:0`) **[ПОДТВЕРЖДЕНО]** |

Для рублей (`valueType: 0`) формула по аналогии **[ГИПОТЕЗА]**:
`10` → `X + amount`, `20` → `X - amount`, `30` → `X`.

### 3.4 `valueType`

| Код | Смысл | Статус |
|---|---|---|
| `0` | рубли (₽) | **[ПОДТВЕРЖДЕНО]** |
| `10` | проценты (%) | **[ПОДТВЕРЖДЕНО]** |

---

## 4. Как Indeepa превращает правила в SQL (псевдокод, восстановлен по логам ошибок)

Реальный сгенерированный запрос из лога ошибки (сокращённо):

```sql
SELECT sampleData.*,
  arrayFirst(a -> (coalesce(a, -1) > 0),
    [
      if((SumStock > 3) AND (QtyTodayBaseExt > 28),
         CalcMinPriceCompetitorPrice_BaseExt * (1 + (20/100)), NULL),
      if((SumStock > 3) AND (QtyTodayBaseExt > 24) AND (CompetitorPriceOzonCard_BaseExt > 9),
         CalcMinPriceCompetitorPrice_BaseExt * (1 + (15/100)), NULL),
      ...
      if((SumStock > 3) AND (QtyTodayBaseExt > 4) AND (MinOzonCardPrice > 9),
         CalcMinPrice * (1 - (2/100)), NULL)
    ]) AS ExpressionResult
FROM sampleData
```

Из этого следует **точная семантика движка**:

```
newPrice = null
for rule in rules:                                  # сверху вниз
    if not rule.enabled: continue
    if not schedule_active(rule): continue
    if eval(rule.conditions, product):              # И/ИЛИ по isOr, children = скобки
        newPrice = calc(rule.priceCalcConfig, product)
        break                                       # первое подходящее — окончательное

if newPrice is None or newPrice <= 0: return        # ничего не меняем
newPrice = clamp(newPrice, min_threshold, max_threshold)   # если ignoreMaximums=false
apply(newPrice)
```

Ключевые детали:

* `coalesce(a, -1) > 0` — **защита от NULL и нуля**: если расчёт дал пусто/0/отрицательное, правило
  считается несработавшим, и движок идёт к следующему правилу. Поэтому в условиях часто пишут
  `CompetitorPrice > 9` — это не «девять рублей», а **техническая проверка валидности** цены конкурента
  (чтобы не сработать на NULL / 0 / мусор). **[ПОДТВЕРЖДЕНО]**
* Порядок массива `if(...)` = порядок правил в JSON. Сверху — самые «узкие»/высокие пороги.
* Условия внутри группы через `AND`; `isOr: true` даёт `OR`.

---

## 5. Что происходит после расчёта (пост-обработка)

Это место, где «стратегия показывает 5932, а цена становится 5697». Порядок и полный список
фильтров Indeepa **не подтверждён документально**, но по настройкам товара видны все «зажимы»,
которые движок может применить после стратегии:

| Механизм | Где видно | Что делает |
|---|---|---|
| Мин./макс. пороги (коридор) | `CalcMinPrice`, `CalcMaxPrice`, `CalcMinPriceOzonCardBySize`, `CalcMaxPriceOzonCardBySize` | обрезает цену в коридор |
| `ignoreMaximums` | поле стратегии | отключает **верхнюю** границу |
| Акции / запрет акций | `Запрет акций`, `Сейчас в акции (расширение)`, `Мин цена акции`, `Снижение цены для акции` | в акции цена дополнительно ограничивается акционной ценой; в истории появляется `Участвуем в акции` |
| Мин. цена получения СПП / бустинга | `SPPMinPrice`, `SPPMaxPrice`, `MinActionPriceWithBoosting3`, `MaxActionPriceWithBoosting3` | ограничения для входа в СПП/буст |
| Ограничение шага цены | `MaxOneTimePriceChange`, `MaxOneDayPriceChange` (кол. 39, 40 отчёта) | «не более N ₽ за раз / за день» |
| Мин. РЦ | `Рекомендуемая розничная цена` (`RecommendedRetailPrice`) | нижняя граница по РРЦ |
| Ночная стратегия | `NightStrategy`, `NightStrategySetting` | отдельная логика ночью |
| Out of stock | `OutStockStrategy` | что делать при нуле остатка |
| СПП-цикл / соинвест | `PriceStopCicleSPP`, `CalcMinPriceStopCicleBaseExt(V2)` | выход из цикла СПП |

В истории пересчёта Indeepa дописывает к строке правила хвост вида:

```
Правило стратегии: <name>: >>5932<<; Участвуем в акции; Мин цена; Следуем за ценой конкурента 6053 с учетом Ozon карты; FBO: 100% / FBS: 0%
```

Расшифровка хвоста **[ГИПОТЕЗА, но очень правдоподобная]**:
* `>>5932<<` — цена, которую **посчитала стратегия** (до пост-обработки);
* `Участвуем в акции` — товар в акции → цена дополнительно ограничена;
* `Мин цена` — итог **упёрся в минимальный порог** (обрезан снизу);
* `Следуем за ценой конкурента 6053 с учетом Ozon карты` — какой конкурентный ориентир использован;
* `FBO: 100% / FBS: 0%` — распределение остатка по схемам.

**Для своего репрайсера:** обязательно храните в истории и `rawCalculatedPrice`, и `finalPrice`,
и список применённых ограничений (`clamps: ["min_threshold"]`). Иначе диагностика невозможна.

---

## 6. Известные подводные камни (реальные грабли)

### 6.1 `LIKE` по числу → 500
```
DB::Exception: Illegal type Float64 of argument of function like ...
Percent_plan_Period LIKE '%100%'
```
Причина: `compareOperator: 30` = LIKE. По числам не применять. Используйте `70` и лесенку правил.

### 6.2 Пробелы в числах в тестовых данных → синтаксическая ошибка
```
select 0 as __test_id,3 AS SumStock,16 AS Percent_plan_Period,8 625 AS CalcMaxPrice,5 914 AS CompetitorPrice
-> Syntax error: failed at position ... 625 AS CalcMaxPrice
```
Писать `8625`, `5914`, `7932` — **без пробелов-разделителей тысяч**.

### 6.3 Поле есть в стратегии, но нет в тест-данных → Unknown identifier
```
DB::Exception: Unknown expression or function identifier `CalcMinPriceCompetitorPrice_BaseExt`
in scope WITH sampleData AS (SELECT ... )
```
Тест в UI собирает подзапрос только из тех полей, что вы перечислили в тест-данных. Любой alias,
использованный в условиях или в `inputFieldAlias`, должен быть добавлен в `testDataRows[].inputs`.

### 6.4 Двойной минус при уменьшении
```json
{ "changeType": 20, "valueType": 10, "changeAmount": -3 }
```
генерирует `X * (1 - (-3/100))` = **рост на 3%** вместо снижения.
Правильно: `changeAmount: 3` (положительное), `changeType: 20`.

### 6.5 Смешивание «цены конкурента» и «цены по карте»
Поля очень похожи, но означают разное:
* `CompetitorPrice` — «Цена селлера конкурента» (цена конкурента **без** карты);
* `CompetitorPriceOzonCard_BaseExt` — «Цена конкурентного следования **по карте**», т.е. цена
  конкурента, пересчитанная под скидку по карте Ozon;
* `MinOzonCardPrice` — «Мин цена конкурента по карте» (минимум по всем конкурентам);
* `LowestCompetitorPrice` / `LowestCompetitorPriceBaseExt` — **это НЕ конкурент**, это
  «Цена выгодного индекса» Ozon (индекс/порог Ozon). Использовать как конкурента — ошибка.
То же с `MaxProfitPrice`, `MaxAVGProfitPrice`, `SuperLowestCompetitorPrice` — это ценовые индексы Ozon.

### 6.6 Расписание пересчёта
Фактический интервал пересчёта цен — **≈40 минут**. Любая логика «утром дешевле, к вечеру дороже»
должна учитывать дискретность: за день реально ~20-30 итераций.

---

## 7. Чего в собранных данных НЕТ (нужно выяснить при переносе)

1. **Полный список `compareOperator`** — подтверждены только `70` (`>`) и `30` (LIKE).
2. **Код `leftExpressionType`/`rightExpressionType` для «поле справа»** — нужен, чтобы писать
   условия вида `QtyTodayBaseExt > AvgOrdersForPeriodPlanBaseExt` (сравнение с полем, а не константой).
3. **Семантика `rightExpression2`** (диапазон? второй операнд?) и `children` в условиях.
4. **Синтаксис `priceCalcExpression`** (произвольное выражение). Движок генерирует ClickHouse-SQL —
   значит поддерживаются `if`, арифметика, `*`, `/`, возможно `greatest/least`. Точный DSL — выяснять.
5. **Порядок пост-обработки** (что раньше: коридор, акция, шаг цены) — влияет на итоговую цену.
6. **Что именно означают `>>N<<`** в истории (до или после коридора) — см. §9, диагностика.
7. `type` для WB, формат `schedule`, поля `addCosts` / `disableStdFormulas`.

**Метод выяснения (5 минут на пункт):** в UI Indeepa собрать минимальную стратегию с нужным
элементом → сохранить → скачать JSON из списка стратегий → сравнить с эталоном. Это единственный
100% надёжный способ, потому что публичного описания формата у Indeepa нет.

---

## 8. Эталонная стратегия: «конкурент + дневной план по заказам»

Это рабочая бизнес-логика, которую нужно воспроизвести в своём репрайсере.

### Постановка
* Товар: `3608719` (Ozon).
* Месячный план: **750 шт за август** (01.08–31.08) → **дневной план ≈ 24 заказа/день**.
* Утром/при малом числе заказов — **дешевле конкурента** (чтобы разогнать заказы).
* По мере набора заказов — **плавно дороже**.
* При выполнении/перевыполнении дневного плана — **дороже, к верхнему порогу**.
* Никогда не ниже мин. порога и не выше макс. порога из настроек Indeepa.

### Ключевой выбор поля
Факт дня берём из **`QtyTodayBaseExt` («Заказы сегодня»)** — это счётчик заказов за текущий день,
он напрямую сопоставим с дневным планом.

⚠️ `Percent_plan_Period` («% выполнения плана за период») — это процент за **весь период плана**
(месяц), а не за день. Для дневной лесенки он не годится (и был первой, неверной попыткой).

### Лесенка (эталон, `Конкурент_дневной_план_v2.json`)

| # | Имя правила | Условия (И) | Расчёт |
|---|---|---|---|
| 9 | `9. Заказов 25+ — Расчетная базовая цена` | `SumStock > 3` | `CalcMaxPrice`, set, 0 |
| 8 | `8. Заказов 21-24 — Конкурент по карте + 10%` | `SumStock > 3`, `QtyTodayBaseExt > 20`, `CompetitorPriceOzonCard_BaseExt > 9` | increase 10% |
| 7 | `7. Заказов 17-20 — Конкурент по карте + 6%` | `SumStock > 3`, `QtyTodayBaseExt > 16`, `CompetitorPriceOzonCard_BaseExt > 9` | increase 6% |
| 6 | `6. Заказов 13-16 — Конкурент по карте + 3%` | `SumStock > 3`, `QtyTodayBaseExt > 12`, `CompetitorPriceOzonCard_BaseExt > 9` | increase 3% |
| 5 | `5. Заказов 9-12 — Как у конкурента по карте` | `SumStock > 3`, `QtyTodayBaseExt > 8`, `CompetitorPriceOzonCard_BaseExt > 9` | set (= конкурент) |
| 4 | `4. Заказов 5-8 — Конкурент по карте - 2%` | `SumStock > 3`, `QtyTodayBaseExt > 4`, `CompetitorPriceOzonCard_BaseExt > 9` | decrease 2% |
| 3 | `3. Заказов 1-4 — Конкурент по карте - 3%` | `SumStock > 3`, `QtyTodayBaseExt > 0`, `CompetitorPriceOzonCard_BaseExt > 9` | decrease 3% |
| 2 | `2. Заказов 0 — Конкурент по карте - 5%` | `SumStock > 3`, `CompetitorPriceOzonCard_BaseExt > 9` | decrease 5% |

**Почему условия именно такие (важно для реализации):**
* Правила идут **сверху вниз от высокого порога к низкому**. `QtyTodayBaseExt > 20` сработает
  первым и «перехватит» все 21+, поэтому `> 16` фактически означает «17–20». Это не баг, а
  штатный способ делать диапазоны в Indeepa (нет `<`/`between` в подтверждённых операторах).
* Последнее правило (`2.`) без порога по заказам = «по умолчанию», ловит 0 заказов.
* `CompetitorPriceOzonCard_BaseExt > 9` = tech-проверка «цена конкурента валидна».
  Если у товара конкурента нет — правило не сработает и цена не изменится (это желаемое поведение).
* `SumStock > 3` = не репрайсить, если товара нет на складе.

Полный JSON — `strategy_example_daily_plan.json`.

### Обобщение лесенки на любой дневной план

```
D = дневной план (например 24)
шаги: 0, 0.17D, 0.35D, 0.5D, 0.7D, 0.85D, D, 1.2D
сдвиги: -5%, -3%, -2%, 0%, +3%, +6%, +10%, max_threshold
```

Где взять `D` автоматически:
* `OrdersPlanQtyPeriodExt` — «План заказов, шт» на период;
* `Count_of_days_in_plan` — «Дней в плане»;
* `AvgOrdersForPeriodPlanBaseExt` — «Средний заказов в день за период плана» ← **это и есть дневной план**;
* `OrdersPlanQty` / `OrdersPlanDays` — план заказов шт / дней (старое расширение).

Но в условиях Indeepa сравнение только с **константой** (`rightExpressionType: 0`). Поэтому либо
пороги вбиваются в правила под каждый товар, либо используется сравнение с полем (см. §7, п.2).

---

## 9. Диагностика «стратегия пишет расчёт, но цена не меняется»

Реальный кейс, который остался нерешённым. Данные по товару `3608719`:

| Показатель | Значение |
|---|---|
| Расчётная мин цена (`CalcMinPrice`) | **7 932** |
| Расчётная базовая цена (`CalcMaxPrice`) | **12 369** |
| Расчётная мин цена по карте Ozon | **5 697** |
| Расчётная базовая цена по карте Ozon | **8 884** |
| Цена конкурента | **6 053** |
| Что писалось в истории | `>>5755<<`, потом `>>5932<<`, в другой день `>>7115<<` |
| Что реально вставало | **5 697** (ровно мин. цена по карте) |

Наблюдения:
* `6053 × (1 − 2%) = 5932` — значит `>>5932<<` действительно цена **по карте**, посчитанная верно.
* `5697` — это ровно нижний порог по карте. То есть итог «упёрся в минимум», хотя 5932 > 5697.
* После ручного снижения минимальной маржи (950 → 300 ₽) цена **уехала сильно вниз** — то есть
  пороги реально влияют, движок их применяет.
* В истории присутствовали `Участвуем в акции` и `Мин цена`.

**Чек-лист проверки (в этом порядке):**

1. **Разделить слои цены.** После пересчёта смотреть одновременно:
   `Текущая цена до скидки` (`PriceBeforeDisc`), `Действующая базовая цена` (`BasePrice`),
   `Цена по карте Ozon` (`OzonCardPrice`), `Цена по стратегии` (`StrategyPrice`), `CalcPrice`.
   Если `StrategyPrice` = 5932, а `OzonCardPrice` = 5697 — вопрос уже не к формуле, а к пост-обработке.
2. **Проверить акцию.** `Сейчас в акции (расширение)`, `Запрет акций`, `Мин цена акции`.
   Даже при запрете акций товар может оставаться в акции до её окончания. В истории хвост
   `Участвуем в акции` = цена ограничена акционной.
3. **Проверить `MaxOneTimePriceChange` / `MaxOneDayPriceChange`** — если стоит лимит шага, цена
   физически не может прыгнуть с 5697 на 5932.
4. **Проверить, к какому слою применяется `inputFieldAlias`.** `CalcMinPrice` — базовая цена;
   `CalcMinPriceOzonCardBySize` — карта. Смешение даёт расчёт «в одной шкале», а применение «в другой».
5. **Минимальный тест «движок вообще ставит цену»:** правило из одного условия
   (`SumStock > 3`), `inputFieldAlias: CalcMaxPrice`, `changeType: 30`, `valueType: 0`, `changeAmount: 0`.
   Если цена не поднялась до 12 369 — проблема не в формуле, а в применении/ограничениях.
6. **Второй тест:** `inputFieldAlias: CompetitorPrice`, `changeType: 30`, `changeAmount: 0` — ровно
   как в старой рабочей стратегии «Следование за конкурентом» (она реально работала на 10 товарах).

**Старая проверенная механика (брать за основу при переносе):**
```json
"priceCalcExpressionConfig": {
  "inputFieldAlias": "CompetitorPrice",
  "changeType": 30,
  "valueType": 0,
  "changeAmount": 0
}
```
Это самое надёжное, что есть: оно подтверждённо применялось к 10 товарам.

---

## 10. Минимальный набор полей для переноса (must have)

Полный словарь — в `indeepa_fields.json` (253 alias-а + 138 «только в отчёте» колонок).
Ниже — минимум, без которого стратегию «конкурент + план» не собрать.

### Остатки и валидность
| Alias | Русское название |
|---|---|
| `SumStock` | Сумма остатков |
| `StockFbo` / `StockFbs` | Сток ФБО / ФБС |
| `SumStockAllSizes` | Остатки (все размеры) |

### Цены текущие
| Alias | Русское название |
|---|---|
| `BasePrice` | Действующая базовая цена |
| `OZONCurrentPriceBeforeDiscount` / `PriceBeforeDisc` | Текущая цена до скидки |
| `OZONCurrentRetailPrice` | Текущая цена без СПП |
| `OZONCurrentRetailtPriceWithSpp` | Текущая цена с СПП |
| `OzonCardPrice` | Цена по карте Ozon |
| `OzonCardPercent` | Процент скидки по карте Ozon |
| `SppPercent` | Процент СПП |
| `StartOfDayPrice` | Базовая цена на начало дня |
| `StartOfDayOzonCardPrice` | Цена на начало дня по карте |
| `StrategyPrice` | Цена по стратегии |
| `CalcPrice` | CalcPrice |

### Пороги (коридор)
| Alias | Русское название |
|---|---|
| `CalcMinPrice` | Расчетная мин цена |
| `CalcMaxPrice` | Расчетная базовая цена |
| `CalcMinPriceMinusCommission` / `CalcMaxPriceMinusCommission` | … минус комиссия |
| `CalcMinPriceOzonCardBySize` | Мин цена по карте (все размеры) |
| `CalcMaxPriceOzonCardBySize` | Макс цена по карте (все размеры) |
| `CalcMinPriceWithSppBySize` / `CalcMaxPriceWithSppBySize` | Мин/Макс цена с СПП (все размеры) |
| `CalcMinPriceByDay` / `CalcMaxPriceByDay` | Расчетная мин/базовая цена (акц) |
| `MinActionPriceBaseExt` | Мин цена акции |
| `SPPMinPrice` / `SPPMaxPrice` | Мин/Макс цена получения СПП |
| `RecommendedRetailPrice` | Мин РЦ (настройка) |
| `ForecastMaxPrice` | Базовая цена из настроек |
| `CostPrice` | Себестоимость |
| `AcquiringPercent` | Процент эквайринга |
| `RelativeCostsFbo/Fbs`, `AbsolutCostsFbo/Fbs` | Относительные / Абсолютные расходы FBO / FBS |

### Конкурент
| Alias | Русское название |
|---|---|
| `CompetitorPrice` | Цена селлера конкурента |
| `CompetitorPrice_BaseExt` | Цена конкурентного следования |
| `CompetitorPriceOzonCard_BaseExt` | **Цена конкурентного следования по карте** ← рабочая база |
| `CompetitorPriceWithSPP_BaseExt` | Цена конкурентного следования с СПП |
| `MinOzonCardPrice` | Мин Цена конкурента по карте |
| `MinDiscountPrice` | Мин Цена конкурента с СПП |
| `MarginAmountCompetitorPrice_BaseExt` | Маржа конкурентной цены, руб |
| `MarginPercentCompetitorPrice_BaseExt` | Маржинальность конкурентной цены, % |
| `ROICompetitorPrice_BaseExt` | ROI цены конкурентного следования |
| `UseCompetitors` | Активация конкурентного следования |
| `CompetitorArray` | массив цен конкурентов (только отчёт) |
| `CompetitorSku` | Sku конкурента |
| `CalcMinPriceCompetitorPrice_BaseExt` | расчётная мин цена при цене конкурентного следования |
| `CalcMaxPriceCompetitorPrice_BaseExt` | расчётная базовая цена при цене конкурентного следования |

⚠️ **Не путать с индексами Ozon** (это не конкуренты):
`LowestCompetitorPrice` / `LowestCompetitorPriceBaseExt` = «Цена выгодного индекса»,
`MaxProfitPrice` = «Макс цена Выгодного индекса», `MaxAVGProfitPrice` = «Макс цена Умеренного индекса»,
`SuperLowestCompetitorPrice` = «Макс цена Супер-выгодного»,
`PriceIndexOzonMinimalPriceBaseExt` = «Цена конкурента на Озон» (из индекса Ozon).

### Заказы и план
| Alias | Русское название |
|---|---|
| `QtyTodayBaseExt` | **Заказы сегодня** ← рабочая база для дневной лесенки |
| `QtyYesterdayCache` | Заказов вчера КЕШ |
| `QtyCurrentMonthCache` | Заказов с начала месяца КЕШ |
| `OrdersByDay7days` | Заказы за 7 дней со вчера |
| `Speed7` / `Speed30` | Скорость 7 / 30 дней |
| `OrdersCount` | Кол-во заказов |
| `SalePlanCurrentMonth` | План продаж на месяц шт |
| `PlanPercentSharedStratagy` | % выполнения плана на месяц |
| `PlanPercentMonthCumulative` | % выполнения плана на месяц нарастающим итогом |
| `OrdersPlanQty` / `OrdersPlanDays` / `OrdersPlanType` | План зак, шт / дн / тип |
| `OrdersPlanQtyPeriodExt` | План заказов, шт (на период) |
| `DateStartPlanPeriodExt` / `DateEndPlanPeriodExt` | Дата начала / окончания плана |
| `AvgOrdersForPeriodPlanBaseExt` | Средний заказов в день за период плана |
| `Count_of_days_in_plan` | Дней в плане |
| `Count_of_days` | Прошедших дней плана |
| `Percent_plan_Period` | % выполнения плана за период |
| `Percent_plan_Current` | % плана нарастающим итогом за период |
| `Percent_plan_Sum` / `Percent_plan_Margin` | % выполнения плана по выручке / марже |
| `OrderQtyPlanPeriodFact` | Заказов на вчера (факт) |
| `Calculate_orders_today` | Заказов на вчера (план) |

### Акции / СПП
| Alias | Русское название |
|---|---|
| `PromoOff` | Запрет акций |
| `IsInPromoNowBaseExt` | Сейчас в акции (расширение) |
| `ActionCompetitorPrice_BaseExt` | Акция для цены конкурентного следования |
| `MaxBoostCompetitorPrice_BaseExt` | Макс буст для цены конкурентного следования |
| `MinActionPriceWithBoosting3` / `MaxActionPriceWithBoosting3` | Мин/Макс цена в бустинге х3 |
| `PriceStopCicleSPP` | Цена вывода из цикла СПП |
| `CalcMinPriceStopCicleBaseExt` / `...V2` | Мин цена вывода из цикла соинвеста / (V2) |
| `DeltaPriceAction` / `PercentDeltaAction` | Сумма / % снижения для входа в акцию |

---

## 11. Алгоритм для реализации в своём репрайсере (псевдокод)

```python
def evaluate(strategy, product, now):
    calc = None
    for rule in strategy.rules:                    # порядок = приоритет
        if not rule.enabled:
            continue
        if rule.schedule and not rule.schedule.active(now):
            continue
        if not conditions_pass(rule.conditions, product):
            continue
        calc = calc_price(rule.priceCalcConfig, product)
        if calc is None or calc <= 0:              # аналог coalesce(a,-1) > 0
            continue
        matched_rule = rule
        break
    if calc is None:
        return None                                # цену не трогаем

    raw = calc

    # ---- пост-обработка (порядок уточнить, см. §7 п.5) ----
    clamps = []
    if not strategy.ignoreMaximums:
        hi = product.max_threshold_for(price_layer(rule))   # CalcMaxPrice / OzonCard / SPP
        if hi and calc > hi:
            calc = hi; clamps.append("max_threshold")

    lo = product.min_threshold_for(price_layer(rule))       # CalcMinPrice / CalcMinPriceOzonCardBySize
    if lo and calc < lo:
        calc = lo; clamps.append("min_threshold")

    if product.in_promo:
        calc = min(calc, product.promo_max_price); clamps.append("promo")

    calc = apply_step_limits(product, calc)                 # MaxOneTime/DayPriceChange
    return PriceResult(raw=raw, final=calc, rule=matched_rule.name, clamps=clamps)


def calc_price(cfg, p):
    if not cfg.useConfig:
        return eval_expression(cfg.priceCalcExpression, p)  # DSL, см. §7 п.4
    c = cfg.priceCalcExpressionConfig
    x = p.value(c.inputFieldAlias)
    if x is None or x <= 0:
        return None
    a = abs(c.changeAmount)                                  # всегда положительная!
    if c.changeType == 10:                                   # увеличить
        return x * (1 + a / 100) if c.valueType == 10 else x + a
    if c.changeType == 20:                                   # уменьшить
        return x * (1 - a / 100) if c.valueType == 10 else x - a
    if c.changeType == 30:                                   # установить
        return x + a if c.valueType != 10 and a else x
    return None


def conditions_pass(groups, p):
    # groups: список групп; между группами — И (в реальных файлах всегда 1 группа)
    return all(group_pass(g, p) for g in groups) if groups else True

def group_pass(g, p):
    vals = [element_pass(e, p) for e in g["elements"]]
    return any(vals) if g["isOr"] else all(vals)

def element_pass(e, p):
    left = p.value(e["leftExpression"]) if e["leftExpressionType"] == 10 else float(e["leftExpression"])
    right = p.value(e["rightExpression"]) if e["rightExpressionType"] == 10 else to_number(e["rightExpression"])
    op = e["compareOperator"]
    if op == 70: return left is not None and right is not None and left > right
    if op == 30: return str(right).strip('%') in str(left)   # LIKE — избегать по числам
    raise NotImplementedError(op)
```

**Главное требование к вашему репрайсеру:** хранить `raw`, `final`, список `clamps` и имя правила —
иначе вы получите ровно ту же ситуацию «показывает 5932, ставит 5697» и её невозможно будет разобрать.

---

## 12. Приложение: чтение отчёта Indeepa

```
Файл: RP-OZ_INPUT_REPORT_COMPILER_REPORT.csv
Кодировка: cp1251
Разделитель: ';'
Колонок: 322
```

```python
import csv
with open('RP-OZ_INPUT_REPORT_COMPILER_REPORT.csv', encoding='cp1251') as f:
    rows = list(csv.DictReader(f, delimiter=';'))
```

Ключевые индексы колонок (0-based) — удобно для быстрого парсинга:

| Индекс | Колонка | Alias |
|---|---|---|
| 0 | ProductId | — |
| 1 | OfferId | — |
| 6 | Базовая цена на начало дня | `StartOfDayPrice` |
| 10 | Цена выгодного индекса | `LowestCompetitorPrice` |
| 15 | Действующая базовая цена | `BasePrice` |
| 16 | Кол-во заказов | `OrdersCount` |
| 21 | Текущая цена с СПП | `OZONCurrentRetailtPriceWithSpp` |
| 23 | Текущая цена без СПП | `OZONCurrentRetailPrice` |
| 24 | Текущая цена до скидки | `OZONCurrentPriceBeforeDiscount` |
| 33 | Мин РЦ (настройка) | `RecommendedRetailPrice` |
| 34 | Базовая цена из настроек | `ForecastMaxPrice` |
| 36 | StrategyPrice | `StrategyPrice` |
| 37 | PriceBeforeDisc | `PriceBeforeDisc` |
| 39 | MaxOneTimePriceChange | `MaxOneTimePriceChange` |
| 40 | MaxOneDayPriceChange | `MaxOneDayPriceChange` |
| 50 | Цена по карте Ozon | `OzonCardPrice` |
| 57 | Запрет акций | `PromoOff` |
| 59 | CalcPrice | `CalcPrice` |
| 62 | IsInPromoNow | `IsInPromoNow` |
| 68 | Расчетная мин цена | `CalcMinPrice` |
| 70 | Расчетная базовая цена | `CalcMaxPrice` |
| 79 | Себестоимость | `CostPrice` |
| 80 | CompetitorArray | `CompetitorArray` |
| 81 | Цена селлера конкурента | `CompetitorPrice` |
| 82 | Активация конкурентного следования | `UseCompetitors` |
| 90 | Сумма остатков | `SumStock` |
| 91 / 92 | Сток ФБО / ФБС | `StockFbo` / `StockFbs` |
| 115 | StrategyNameId | — (какая стратегия назначена) |
| 142 | План продаж на месяц шт | `SalePlanCurrentMonth` |
| 149 | % выполнения плана на месяц | `PlanPercentSharedStratagy` |
| 150 | % выполнения плана на месяц нарастающим итогом | `PlanPercentMonthCumulative` |
| 182 / 183 / 184 | План зак, шт / дн / тип | `OrdersPlanQty` / `OrdersPlanDays` / `OrdersPlanType` |
| 189 | Процент выполнения плана (базовое расширение) | `PlanPercentBaseExt` |
| 199 | Заказы сегодня | `QtyTodayBaseExt` |
| 209 / 210 | Цена селлера / по Ozon-карте последнего заказа | `LastOrder…_BaseExt` |
| 212 | Цена конкурентного следования | `CompetitorPrice_BaseExt` |
| 213 | Цена конкурентного следования по карте | `CompetitorPriceOzonCard_BaseExt` |
| 214 | Цена конкурентного следования с СПП | `CompetitorPriceWithSPP_BaseExt` |
| 220 | План заказов, шт | `OrdersPlanQtyPeriodExt` |
| 223 / 224 | Дата начала / окончания плана | `DateStartPlanPeriodExt` / `DateEndPlanPeriodExt` |
| 227 / 228 | Дней в плане / Прошедших дней плана | `Count_of_days_in_plan` / `Count_of_days` |
| 235 / 236 / 237 | % выполнения плана за период / по выручке / по марже | `Percent_plan_Period` / `_Sum` / `_Margin` |
| 257 / 259 | Мин цена до СПП / по карте (все размеры) | `CalcMinPriceBySize` / `CalcMinPriceOzonCardBySize` |
| 265 / 267 | Макс цена до СПП / по карте (все размеры) | `CalcMaxPriceBySize` / `CalcMaxPriceOzonCardBySize` |
| 321 | Цена по стратегии | `StrategyPrice` |

Полный маппинг alias ↔ русское название ↔ колонка отчёта: **`indeepa_fields.json`**.

---

## 13. Файлы в комплекте

| Файл | Что внутри |
|---|---|
| `INDDEEPA_STRATEGY_SPEC.md` | этот документ — полное описание формата и логики |
| `indeepa_fields.json` | словарь всех 253 alias-ов + русские названия + колонки отчёта; отдельно 138 колонок без alias |
| `strategy_schema.json` | JSON Schema для валидации/генерации стратегий |
| `strategy_example_daily_plan.json` | эталонная стратегия «конкурент + дневной план 24 заказа» |
| `strategy_example_competitor.json` | минимальная проверенная стратегия «следование за конкурентом» (`changeType:30`) |

---

## 14. Итоговые правила «как делать правильно» (чек-лист)

1. ✅ Правила — **сверху вниз от высокого порога к низкому**, первое подходящее побеждает.
2. ✅ Диапазоны — **двумя-тремя правилами**, а не `LIKE`/`between`.
3. ✅ `changeAmount` — **всегда положительное**; направление задаёт `changeType`.
4. ✅ В условиях всегда добавлять **валидатор** `CompetitorPrice(или OzonCard) > 9` и `SumStock > 3`.
5. ✅ Дневной факт — `QtyTodayBaseExt`, а не `Percent_plan_Period`.
6. ✅ Конкурент по карте — `CompetitorPriceOzonCard_BaseExt`; индексы Ozon (`LowestCompetitorPrice`,
   `MaxProfitPrice`, `MaxAVGProfitPrice`) — **не конкуренты**.
7. ✅ Тест-данные: числа **без пробелов**, все используемые alias-ы **перечислены**.
8. ✅ Хранить в истории `raw` / `final` / `clamps` / имя правила.
9. ✅ Интервал пересчёта ~40 минут — учитывать в логике «утро/вечер».
10. ✅ Все непонятные коды (`compareOperator`, `rightExpressionType`, `schedule`) выяснять
    сохранением стратегии из UI и диффом JSON, а не угадыванием.
