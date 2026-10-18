// 헤드리스 시뮬레이션: node tools/simulate.js [seed] [days]
const { loadGame } = require('./load');
const seed = +process.argv[2] || 1, days = +process.argv[3] || 400;
const sandbox = loadGame();
const G = sandbox.newGame(seed, 6);
console.log('land provinces:', G.landCount);
const line = () => G.countries.map(c => `${c.name}${c.alive ? '' : '✝'}=${sandbox.ownedCount(G, c.id)}p/${G.armies.filter(a => a.owner === c.id).length}a${c.faction >= 0 ? '#' + c.faction : ''}`).join(' ');
for (let d = 0; d < days && !G.over; d++) {
  sandbox.tickDay(G);
  if ((d + 1) % 100 === 0) console.log(`day ${G.day}:`, line());
}
console.log('wars:', Object.keys(G.wars).length, 'factions:', G.factions.filter(Boolean).map(f => f.name));
console.log('log tail:', G.log.slice(-5).map(l => l.text));
