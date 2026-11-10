// Sends alerts for new/changed records tied to watchlist projects.
// Configure any of these env vars (all optional):
//   ENVMON_WEBHOOK_URL      generic JSON POST (Slack/Teams/Discord-compatible "text" field)
//   ENVMON_TELEGRAM_TOKEN + ENVMON_TELEGRAM_CHAT_ID
//   ENVMON_NTFY_TOPIC       e.g. https://ntfy.sh/my-psp-alerts
import { fetch, EnvHttpProxyAgent } from 'undici';

const dispatcher = new EnvHttpProxyAgent();

export function formatEvent(e) {
  const who = e.projectNames?.length ? `[${e.projectNames.join(', ')}] ` : e.discovered ? '[Discovered] ' : '';
  const what =
    e.kind === 'new'
      ? 'New record'
      : `Changed: ${e.changes.map((c) => `${c.field} "${c.from ?? '–'}" → "${c.to ?? '–'}"`).join('; ')}`;
  return `${who}${e.sourceName}: ${what}\n${e.title}${e.url ? `\n${e.url}` : ''}`;
}

export async function notify(events, log = console) {
  const todo = events.filter((e) => !e.initial && (e.projectIds?.length || e.discovered));
  if (!todo.length) return 0;
  const text = todo.map(formatEvent).join('\n\n');
  const jobs = [];
  const { ENVMON_WEBHOOK_URL, ENVMON_TELEGRAM_TOKEN, ENVMON_TELEGRAM_CHAT_ID, ENVMON_NTFY_TOPIC } = process.env;
  const post = (url, body, headers = { 'content-type': 'application/json' }) =>
    fetch(url, { method: 'POST', body, headers, dispatcher }).then((r) => {
      if (!r.ok) throw new Error(`${new URL(url).host} responded ${r.status}`);
    });

  if (ENVMON_WEBHOOK_URL) jobs.push(post(ENVMON_WEBHOOK_URL, JSON.stringify({ text, events: todo })));
  if (ENVMON_TELEGRAM_TOKEN && ENVMON_TELEGRAM_CHAT_ID)
    jobs.push(
      post(
        `https://api.telegram.org/bot${ENVMON_TELEGRAM_TOKEN}/sendMessage`,
        JSON.stringify({ chat_id: ENVMON_TELEGRAM_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true }),
      ),
    );
  if (ENVMON_NTFY_TOPIC)
    jobs.push(post(ENVMON_NTFY_TOPIC, text.slice(0, 4000), { title: `Environment Monitor: ${todo.length} update(s)` }));

  for (const r of await Promise.allSettled(jobs)) if (r.status === 'rejected') log.warn(`notify failed: ${r.reason.message}`);
  log.info(`\n=== ${todo.length} alert(s) ===\n${text}\n`);
  return todo.length;
}
