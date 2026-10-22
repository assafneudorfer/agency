---
name: tool-card
description: כרטיס כלי — every Aliyapp builder project must have tsion-tool.json. No card, no queue for Tsion. Minimum fields for what it does, audience, journey stage, ABCDE, languages, org, maintainer after Demo Day, and whether Tsion can call an MCP action.
---

# כרטיס כלי (`tsion-tool.json`)

כל פרויקט נולד עם כרטיס. **בלי כרטיס — אין תור לציון.**

## מתי

- ביצירת פרויקט חדש — צור `tsion-tool.json` בשורש הפרויקט (או בנתיב שהתבנית מגדירה).
- לפני בקשת אישור / Demo Day — עדכן את הכרטיס כך שיהיה מלא ואמיתי.
- הסכמה: `aliyapp/schema/tsion-tool.schema.json` בפורק.

## שדות מינימום

| שדה | משמעות |
|---|---|
| `summary` | מה הכלי עושה, **במשפט אחד** |
| `audience` | `oleh` / `volunteer` / `partner` / `staff` |
| `journeyStage` | שלב במסע העלייה (מחרוזת קצרה, למשל `pre-aliyah`, `first-year`) |
| `abcde` | אחד או יותר מ־`A`–`E` (ראה `abcde-journey`) |
| `languages` | מתוך `he`, `en`, `fr`, `ru`, `es`, `pt`, `uk` |
| `organization` | שם הארגון מאחורי האתגר/הכלי |
| `maintainerAfterDemoDay` | מי מתחזק אחרי Demo Day |
| `tsionMcpAction` | האם יש פעולת MCP שציון יכול לקרוא (`false` או תיאור קצר) |

## כללים

- אל תמציא ארגון או מתחזק. אם חסר — שאל את הבילדר.
- בפיילוט: אין שמות עולים בכרטיס. ספירות או mock בלבד בשדות נתונים.
- כרטיס חלקי מסומן; כרטיס ריק חוסם תור.

## דוגמה לשלב 0

ראה `aliyapp/examples/klita-challenges/tsion-tool.json`.
