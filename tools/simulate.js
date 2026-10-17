// 헤드리스 시뮬레이션: node tools/simulate.js [seed] [days]
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = vm.createContext({ console, Math });
for (const f of ['map', 'game', 'ai']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f + '.js'), 'utf8'), ctx, { filename: f + '.js' });
const seed = +process.argv[2] || 1, days = +process.argv[3] || 400;
const G = vm.runInContext(`newGame(${seed}, 6)`, ctx);
vm.runInContext('G_=null', ctx); ctx.G_ = G;
const run = vm.runInContext;
console.log('land provinces:', G.landCount);
for (let d = 0; d < days && !G.over; d++) {
  run('tickDay(G_)', ctx);
  if ((d + 1) % 100 === 0) console.log(`day ${G.day}:`, G.countries.map(c => `${c.name}${c.alive ? '' : '✝'}=${G.provs.filter(p => p.owner === c.id).length}p/${G.armies.filter(a => a.owner === c.id).length}a`).join(' '));
}
console.log('wars:', Object.keys(G.wars).length, 'log tail:', G.log.slice(-5).map(l => l.text));
console.log('initial sizes:', vm.runInContext(`newGame(${seed},6)`, ctx).countries.map(c => c.name).join(','));
