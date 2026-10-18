// 브라우저 전용 코드를 제외한 게임 로직(map/game/ai)을 Node 샌드박스에 로드하고 API를 돌려준다.
const fs = require('fs'), vm = require('vm'), path = require('path');
const EXPORTS = ['newGame', 'tickDay', 'serialize', 'deserialize', 'ownedCount', 'controlledCount', 'strength', 'declareWar', 'proposePeace',
  'proposeAlliance', 'formAlliance', 'findPath', 'visibleSet', 'splitArmy', 'mergeArmies', 'spawnArmy', 'enterable', 'moveDays',
  'warScore', 'atWar', 'sameFaction', 'neighborsOf', 'UNITS', 'TERRAIN', 'generateMap', 'findProvince', 'createFront', 'assignToFront', 'frontBorder', 'dissolveFront', 'friendlyPath', 'frontCandidate', 'addArrow', 'pruneArrows', 'factoriesOf', 'queueBuild', 'cancelBuild', 'setAlloc', 'addTrainLine', 'removeLine', 'freeSlots', 'warParticipants', 'compileTemplate', 'designTemplate', 'deleteTemplate', 'registerTemplate', 'templateIdsFor', 'describeTemplate', 'armyStr', 'unitStr', 'setPlayer', 'setDifficulty', 'diffOf', 'DIFFICULTY', 'BN', 'SUPPORT', 'PRESETS', 'MAX_BN', 'MAX_SUP', 'MAX_TEMPLATES', 'resetTemplates', 'EQUIP', 'TRAIN_DAYS', 'FACTORY_COST'];
exports.loadGame = function () {
  const ctx = vm.createContext({ console, Math, JSON });
  const src = ['map', 'divisions', 'game', 'economy', 'fronts', 'ai'].map(f => fs.readFileSync(path.join(__dirname, '..', 'js', f + '.js'), 'utf8')).join('\n;\n')
    + `\n;globalThis.API = { ${EXPORTS.join(', ')} };`;
  vm.runInContext(src, ctx, { filename: 'game-bundle.js' });
  return ctx.API;
};
