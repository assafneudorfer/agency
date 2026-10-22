---
name: seven-languages-rtl
description: Seven product languages (he, en, fr, ru, es, pt, uk). Hebrew is RTL with CSS logical properties, not left/right. Missing translations stay in the structure and are marked missing. Same variables in every language.
---

# שבע שפות ו־RTL

לפי DEC-2026-10-15-003.

## שפות חובה

| קוד | שפה |
|---|---|
| `he` | עברית (RTL) |
| `en` | אנגלית |
| `fr` | צרפתית |
| `ru` | רוסית |
| `es` | ספרדית |
| `pt` | פורטוגזית |
| `uk` | אוקראינית |

## RTL

- ממשק עברית: `dir="rtl"` / כיוון לוגי.
- ב־CSS השתמש ב**מאפיינים לוגיים** (`margin-inline-start`, `inset-inline-end`, `text-align: start`) — לא ב־`left` / `right` למיקום תוכן.

## תרגומים חסרים

- תבנית בלי תרגום **נשארת במבנה** ומסומנת חסרה (למשל מפתח עם סמן `missing` או טקסט נראה לעין למפתחים).
- **אותם משתנים** בכל השפות — אין שמות מפתח שונים לפי שפה.

## כרטיס כלי

שדה `languages` ב־`tsion-tool.json` חייב להיות תת־קבוצה של הרשימה למעלה. אם חסרות שפות — ציין זאת בכרטיס, אל תמחק מפתחות.
