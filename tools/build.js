// 정적 사이트 빌드: js/*.js를 app.js 하나로 합치고 캐시 무효화용 해시를 붙여 dist/에 출력한다.
// 의존성 없음. 결과물(dist/)은 어떤 정적 호스팅에든 그대로 올리면 된다.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..'), dist = path.join(root, 'dist');
const ORDER = ['map', 'game', 'economy', 'fronts', 'ai', 'ui'];
const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);

const js = ORDER.map(f => `/* ${f}.js */\n` + fs.readFileSync(path.join(root, 'js', f + '.js'), 'utf8')).join('\n');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const scriptTags = /(\s*<script src="js\/[^"]+"><\/script>)+/;
if (!scriptTags.test(html)) throw new Error('index.html에서 js 스크립트 태그를 찾지 못했다');
html = html.replace(scriptTags, `\n<script src="app.js?v=${hash(js)}"></script>`)
  .replace('href="style.css"', `href="style.css?v=${hash(css)}"`);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
fs.writeFileSync(path.join(dist, 'app.js'), js);
fs.writeFileSync(path.join(dist, 'style.css'), css);
fs.writeFileSync(path.join(dist, 'index.html'), html);
fs.writeFileSync(path.join(dist, '.nojekyll'), '');
const kb = f => (fs.statSync(path.join(dist, f)).size / 1024).toFixed(1) + ' KB';
console.log(`dist/ built: index.html ${kb('index.html')}, app.js ${kb('app.js')}, style.css ${kb('style.css')}`);
