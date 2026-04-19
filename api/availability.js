// Schedules endpoint — returns static departure times by season type.
// Structured to be replaceable by live FareHarbor API data in the future.
const SCHEDULES = require('../data/schedules.json');

module.exports = function handler(req, res) {
  const origin  = req.headers.origin || '';
  const allowed = process.env.ALLOWED_ORIGIN || 'https://viamar-berlenga.com';

  if (origin === allowed || /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  const [, mm, dd] = date.split('-').map(Number);
  const mmdd = `${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;

  let times = [];
  for (const season of SCHEDULES.seasons) {
    for (const range of season.ranges) {
      if (mmdd >= range.from && mmdd <= range.to) {
        times = season.times;
        break;
      }
    }
    if (times.length) break;
  }

  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({ times, date });
};
