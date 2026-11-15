import mpcb from './mpcb.js';
import pariveshTrack from './parivesh-track.js';
import pariveshCommittees from './parivesh-committees.js';
import ecLegacy from './ec-legacy.js';
import fcLegacy from './fc-legacy.js';
import pageWatch from './page-watch.js';
import ecMinutes from './ec-minutes.js';

export default Object.fromEntries(
  [mpcb, pariveshTrack, pariveshCommittees, ecLegacy, fcLegacy, pageWatch, ecMinutes].map((c) => [c.id, c]),
);
