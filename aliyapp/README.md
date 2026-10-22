<div dir="rtl" lang="he">

# שכבת Aliyapp על פורק Agency

התיקייה הזו היא **שכבת Aliyapp** בלבד: Skills ארגוניים, סכמת כרטיס כלי, ודוגמה לשלב 0.  
היא יושבת בפורק של [Agency](https://github.com/assafneudorfer/agency) (Apache 2.0). הקוד של Agency עצמו לא ממותג מחדש בפריסה הזו.

## מה יש כאן

| נתיב | תפקיד |
|---|---|
| `skills/tsion-builders/` | ציון לבילדרים — נטען בכל שיחה |
| `skills/tool-card/` | חובת `tsion-tool.json` |
| `skills/privacy-file-boundary/` | פרטיות וגבול תיק העלייה |
| `skills/seven-languages-rtl/` | 7 שפות ו־RTL לוגי |
| `skills/abcde-journey/` | מיון ABCDE, לא חמש לשוניות |
| `schema/tsion-tool.schema.json` | סכמת כרטיס הכלי |
| `examples/klita-challenges/` | דוגמת שלב 0 — לוח אתגרים (mock) |

לא נכללים בפריסה הזו: סקיל עיצוב, סקיל MCP של ארגון, סקיל פינג לשותף, שינוי מיתוג Axel.

## איך מייבאים את ה־Skills ב־Agency

Skills **לא** נטענים מקוד האפליקציה. הם Skills ארגוניים:

1. להריץ את הפורק מקומית (`docker compose`, `localtest.me`) — בלי `infra/aws/deploy.sh` ובלי פריסת AWS/Azure בלי אישור.
2. ב־Agency: **Settings → Skills** (ארגון).
3. **From GitHub**: קישור לתיקיית הסקילים בפורק, למשל  
   `https://github.com/<בעלים-של-הפורק>/agency/tree/<ענף>/aliyapp/skills`  
   או קישור לתיקייה של סקיל בודד. ייבוא של תיקייה עם כמה סקילים מייבא את כולם; **Update** מרענן.
4. לוודא שהסקילים מופעלים לארגון. pi רואה אותם לפי `name` ו־`description` ב־frontmatter.

פירוט ב־`docs/skills.md` של Agency.

## שלב 0

הדוגמה ב־`examples/klita-challenges/` היא הוכחה פנימית: לוח אתגרי קליטה לפי שלב במסע ולפי ABCDE, עם ספירת ממתינים וקישור למדריך. הנתונים מסומנים כ־**mock**.  
**שלב 0 לא נפרס.** אין Salesforce חי, אין תיקי עלייה, אין מייל לעולים.

## מה לא עושים מכאן

- לא דוחפים ל־`assafneudorfer/agency` (upstream).
- לא מריצים `deploy.sh` ולא פותחים משאבי ענן בלי אישור אשל.
- לא שולחים מייל ולא מפרסמים החוצה בלי «מאשר».

</div>
