// Generic "what's new" watcher: every link on the page becomes a record, so new
// circulars, notices, hearings or reports show up as new events. Used for CPCB, CPC etc.
import * as cheerio from 'cheerio';
import { HttpSession } from '../lib/http.js';
import { absUrl, clean } from '../lib/util.js';

const SKIP = /^(home|login|sign ?in|contact( us)?|sitemap|skip to main content|screen reader access|feedback|help|faq|privacy policy|disclaimer|terms|hindi|english|a\+|a-|a)$/i;

export function linksAsRecords(html, pageUrl, { selector = 'body', minLength = 12 } = {}) {
  const $ = cheerio.load(html);
  $('script,style,noscript,header nav,footer').remove();
  const seen = new Map();
  $(selector)
    .find('a[href]')
    .each((_, a) => {
      const label = clean($(a).text() || $(a).attr('title'));
      const url = absUrl($(a).attr('href'), pageUrl);
      if (!url || !/^https?:/.test(url) || label.length < minLength || SKIP.test(label)) return;
      if (!seen.has(url)) seen.set(url, { key: url, title: label.slice(0, 300), url, status: null, fields: {}, docs: [{ label: 'Open', url }] });
    });
  return [...seen.values()];
}

export default {
  id: 'page-watch',
  async run({ source }) {
    const http = new HttpSession({ caFile: source.caFile });
    const html = await http.getText(source.url);
    return { records: linksAsRecords(html, source.url, source.options) };
  },
};
