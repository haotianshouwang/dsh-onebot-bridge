import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
function fixture() {
  const loader = source.slice(source.indexOf('async function loadPage('), source.indexOf('async function pageAction('));
  const start = source.indexOf('function qzoneView()');
  const view = source.slice(start, source.indexOf("  const loading = pluginLoading('qzone'", start)) + '}';
  const box = {Map, Date, state: {view: 'qzone'}, pageCache: new Map(), uiFor: () => ({}), formatError: e => e.message, toast: () => {}, attempts: 0};
  vm.createContext(box);
  vm.runInContext(loader + '\n' + view + `
    const pageLoaders = {qzone: async () => {attempts++; throw Error('真实读取失败');}};
    function render() {if (attempts < 5) qzoneView();}
    render();
  `, box);
  return box;
}

test('空间初次加载失败后保留错误，不在渲染中无限重试', async () => {
  const box = fixture();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(box.attempts, 1);
  assert.equal(box.pageCache.get('qzone').loading, false);
  assert.equal(box.pageCache.get('qzone').error, '真实读取失败');
  vm.runInContext('render();render();', box);
  assert.equal(box.attempts, 1);
  await vm.runInContext("loadPage('qzone', async () => ({overview: {enabled: true}}), {force: true})", box);
  assert.equal(box.pageCache.get('qzone').error, null);
});

test('退出或会话过期清理缓存后，旧请求不能把数据重新写回来', async () => {
  const box = fixture();
  await new Promise(resolve => setTimeout(resolve, 20));
  vm.runInContext("state.view='listen';pageCache.clear();var finish;var pending=loadPage('qzone', () => new Promise(resolve => {finish=resolve;}), {force:true});pageCache.clear();finish({privateData:'old'});", box);
  await box.pending;
  assert.equal(box.pageCache.has('qzone'), false);
});

test('原生包只有 manifest.id 时，心情入口和保存仍使用真实插件 ID', () => {
  const start = source.indexOf('function pluginCard(');
  const code = source.slice(start, source.indexOf('function pluginsView()', start));
  const buttons = [];
  const calls = [];
  const box = {
    el: (...args) => args,
    toggle: () => null,
    button: (label, click) => {buttons.push({label, click}); return null;},
    scopeEditor: scope => ({node: null, read: () => scope}),
    configForm: () => ({node: null, read: () => ({autoObserve: true})}),
    act: (...args) => calls.push(args),
    showEmotionStatus: () => {},
    toast: () => {}
  };
  vm.createContext(box);
  vm.runInContext(code + `pluginCard({manifest:{id:'qq-emotion',name:'情绪与见闻'},enabled:true,scope:{groups:['88888']}},'native');`, box);
  assert.ok(buttons.some(item => item.label === '查看心情与分享记录'));
  buttons.find(item => item.label === '保存').click();
  assert.equal(calls[0][0], 'configureNativePackage');
  assert.equal(calls[0][1].id, 'qq-emotion');
});
