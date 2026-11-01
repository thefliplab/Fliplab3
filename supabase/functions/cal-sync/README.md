# cal-sync (Google Calendar sync for FlipLab 3.0)
- `week.ts` is a copy of `/week.js` with an export line at the end. After changing `/week.js`, regenerate it:
  `(echo '// @ts-nocheck'; cat ../../../week.js; echo 'export { applyExceptions, buildWeek, timeVal, DAYS, runsBetween, priceFor, isSpecial };') > week.ts`
  and redeploy the function.
- Deployed with verify_jwt = false (pg_cron calls it every minute while `cal_queue` has weeks; calling it only drains the queue).
- Secret `GOOGLE_SA_JSON` = the Google service-account key (JSON). The calendar must be shared with the service account's email ("Make changes to events").
- Settings: table `cal_settings` (Account → Calendar sync in the admin page). Only events with private property `fl3=1` are ever changed.
