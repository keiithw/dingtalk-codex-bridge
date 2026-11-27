const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {createRelay} = require('./relay.cjs');

const baseUrl = 'https://jenkins.example/ci';
const build = baseUrl + '/job/folder/job/service/42/';
const mr = 'https://team.coding.net/p/project/d/repo/git/merge/42';
const groups = [{id:'group-id', name:'Team Group'}];

function fixture(t, fetchBuild) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-relay-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  let time = 1700000000000;
  const notifications = [];
  const create = () => createRelay({file:path.join(dir,'relay.json'), baseUrl, fetchBuild, now:() => time, notify:job => notifications.push(job)});
  return {create, notifications, advance:ms => {time += ms;}, time:() => time};
}

test('Jenkins checks only the exact build and persists one result with SHA across restart', async t => {
  const sha = 'a'.repeat(40);
  let calls = 0;
  const f = fixture(t, async (url, options) => {
    assert.equal(url.origin + url.pathname, build + 'api/json');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    calls++;
    const data = calls === 1 ? {number:43, building:false, result:'SUCCESS'}
      : {number:42, building:false, result:'SUCCESS', actions:[{lastBuiltRevision:{SHA1:sha}}]};
    return {ok:true, json:async () => data};
  });
  const relay = f.create();
  assert.match(relay.command('/relay jenkins ' + build, 'owner', 'thread', []), /waiting/);
  assert.match(relay.command('/relay jenkins ' + build, 'owner', 'thread', []), /Already watching/);
  await relay.tick();
  assert.match(relay.command('/relay status', 'owner'), /waiting/);
  const restarted = f.create();
  await restarted.tick();
  await restarted.tick();
  assert.equal(calls, 2);
  assert.equal(f.notifications.length, 1);
  assert.match(restarted.context('owner', 'thread'), new RegExp('SUCCESS.*' + sha));
  assert.equal(restarted.context('owner', 'other-thread'), '');
  assert.match(restarted.command('/relay status', 'other-owner'), /No relay/);
});

test('Jenkins rejects other origins, non-build paths and encoded path separators', t => {
  const relay = fixture(t).create();
  for (const url of ['https://other.example/ci/job/service/42/', baseUrl + '/job/service/lastBuild/',
    baseUrl + '/job/service/api/json', baseUrl + '/job/service%2fconfig/42/', build + '?secret=test']) {
    assert.throws(() => relay.command('/relay jenkins ' + url, 'owner', 'thread', []));
  }
});

test('MR signal requires the registered group, sender, full URL and a fresh callback', async t => {
  const f = fixture(t);
  const relay = f.create();
  assert.match(relay.command('/relay mr ' + mr + ' reviewer 3 | Team Group', 'owner', 'thread', groups), /waiting/);
  const event = {group:'group-id', sender:'reviewer', text:'\u5df2\u5408\u5e76 ' + mr, messageId:'message-id', sentAt:f.time()};
  for (const change of [{group:'wrong'}, {sender:'wrong'}, {text:event.text.replace('/repo/','/else/')},
    {sentAt:event.sentAt - 1}, {messageId:undefined}, {text:'OK ' + mr}]) {
    relay.observeMr({...event, ...change});
  }
  assert.equal(relay.context('owner', 'thread'), '');
  relay.observeMr(event);
  relay.observeMr(event);
  await Promise.resolve();
  assert.equal(f.notifications.length, 1);
  assert.match(relay.context('owner', 'thread'), /mr-signal.*message-id.*signal only/);
});

test('cancellation wins over an in-flight response and does not notify', async t => {
  let complete;
  const f = fixture(t, () => new Promise(resolve => {complete = resolve;}));
  const relay = f.create();
  const id = relay.command('/relay jenkins ' + build, 'owner', 'thread', []).match(/[\da-f-]{36}/)[0];
  const polling = relay.tick();
  assert.match(relay.command('/relay cancel ' + id, 'other'), /No waiting/);
  assert.match(relay.command('/relay cancel ' + id, 'owner'), /Cancelled/);
  complete({ok:true, json:async () => ({number:42, building:false, result:'SUCCESS'})});
  await polling;
  assert.match(relay.command('/relay status ' + id, 'owner'), /cancelled/);
  assert.equal(f.notifications.length, 0);
});

test('unavailable Jenkins API expires without claiming build failure', async t => {
  const f = fixture(t, async () => ({ok:false, status:403}));
  const relay = f.create();
  relay.command('/relay jenkins ' + build + ' 1', 'owner', 'thread', []);
  await relay.tick();
  assert.match(relay.command('/relay status', 'owner'), /waiting/);
  f.advance(60000);
  await relay.tick();
  assert.match(relay.command('/relay status', 'owner'), /expired/);
  assert.equal(f.notifications.length, 1);
});
