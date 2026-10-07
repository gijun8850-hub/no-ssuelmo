'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const htmlPath = path.join(__dirname, 'index.html');

function setup(random = () => 0.999999) {
  assert.ok(fs.existsSync(htmlPath), '실행 가능한 단일 HTML 파일이 있어야 한다');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const script = html.match(/<script id="game-code">([\s\S]*?)<\/script>/);
  assert.ok(script, '게임 스크립트는 HTML에 포함되어야 한다');
  const sandbox = { module: { exports: {} }, setTimeout, clearTimeout, Date, Math };
  vm.runInNewContext(script[1], sandbox, { filename: 'game-code.js' });
  const { SwitchGame, EVENT_TYPES, isDirectPointerClick } = sandbox.module.exports;
  assert.equal(typeof SwitchGame, 'function');
  let clock = 0;
  let serial = 0;
  const tasks = new Map();
  const changes = [];
  const game = new SwitchGame({
    random,
    now: () => clock,
    schedule: (fn, delay) => { const id = ++serial; tasks.set(id, { fn, at: clock + delay }); return id; },
    cancel: id => tasks.delete(id),
    onChange: (state, message) => changes.push({ state, message })
  });
  function advance(ms) {
    const target = clock + ms;
    while (true) {
      const ready = [...tasks].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at);
      if (!ready.length) break;
      const [id, task] = ready[0];
      tasks.delete(id);
      clock = task.at;
      task.fn();
    }
    clock = target;
  }
  function click(times) { for (let i = 0; i < times; i++) { assert.equal(game.press(), true); advance(game.getSnapshot().stage === 1 ? 600 : 180); } }
  function reachCandle() { click(99); assert.equal(game.press(), true); }
  return { game, advance, click, reachCandle, changes, tasks, EVENT_TYPES, html, isDirectPointerClick };
}
// Fund only model fixtures to verify the deliberately unreachable shop boundary without a million inputs.
function buyGoldenForFixture(game) { game.points = 999999; assert.equal(game.buyGolden(), true); }

test('불을 끄고 집주인이 0.6초 안에 다시 켠다', () => {
  const { game, advance } = setup();
  assert.equal(game.getSnapshot().lit, true);
  assert.equal(game.press(), true);
  assert.equal(game.getSnapshot().lit, false);
  advance(599);
  assert.equal(game.getSnapshot().lit, false);
  advance(1);
  assert.equal(game.getSnapshot().lit, true);
});

test('불이 꺼져 있을 때 중복 입력으로 점수를 올릴 수 없다', () => {
  const { game } = setup();
  game.press();
  assert.equal(game.press(), false);
  assert.equal(game.getSnapshot().count, 1);
});

test('첫 번째 클릭의 절약 리포트 수치가 사양과 일치한다', () => {
  const { game } = setup();
  game.press();
  const state = game.getSnapshot();
  assert.equal(state.stats.warming, '0.000000001');
  assert.equal(state.stats.money, '0.0004');
  assert.equal(state.stats.stress, 89400);
  assert.equal(state.stats.chance, '-0.02');
  assert.equal(state.stats.remaining, 1244999999);
  assert.equal(state.anger, 1);
});

test('짜증 단계에서는 0.1초 만에 복구된다', () => {
  const { game, click, advance } = setup();
  click(24);
  assert.equal(game.getSnapshot().stage, 1);
  game.press();
  assert.equal(game.getSnapshot().stage, 2);
  advance(99);
  assert.equal(game.getSnapshot().lit, false);
  advance(1);
  assert.equal(game.getSnapshot().lit, true);
});

test('폭발 단계와 100% 해탈 전환, 촛불 이후에도 집계된다', () => {
  const { game, click } = setup();
  click(50);
  assert.equal(game.getSnapshot().stage, 3);
  click(50);
  assert.equal(game.getSnapshot().stage, 4);
  assert.equal(game.getSnapshot().anger, 100);
  assert.equal(game.getSnapshot().candle, true);
  assert.equal(game.getSnapshot().lit, true);
  click(3);
  assert.equal(game.getSnapshot().count, 103);
  assert.equal(game.getSnapshot().anger, 100);
});

test('테이프는 세 번째 입력에서 제거되고 그때만 불이 꺼진다', () => {
  const { game } = setup();
  game.triggerEvent('tape');
  assert.equal(game.press(), false);
  assert.equal(game.getSnapshot().tapeRemaining, 2);
  assert.equal(game.press(), false);
  assert.equal(game.getSnapshot().count, 0);
  assert.equal(game.press(), true);
  assert.equal(game.getSnapshot().tapeRemaining, 0);
  assert.equal(game.getSnapshot().event, null);
  assert.equal(game.getSnapshot().count, 1);
});

test('15% 미만의 난수에서만 방해 이벤트를 발동한다', () => {
  const sequence = [0.99, 0.149, 0];
  const { game } = setup(() => sequence.shift() ?? 0.99);
  game.press();
  assert.equal(game.getSnapshot().event.type, 'captcha');
  const excluded = setup(() => 0.15);
  excluded.game.press();
  assert.equal(excluded.game.getSnapshot().event, null);
});

test('확률 발동으로 열 종류의 이벤트를 모두 선택할 수 있다', () => {
  const { EVENT_TYPES } = setup();
  assert.equal(EVENT_TYPES.length, 10);
  EVENT_TYPES.forEach((type, index) => {
    const values = [0.99, 0, (index + 0.5) / 10];
    const { game } = setup(() => values.shift() ?? 0.99);
    game.press();
    assert.equal(game.getSnapshot().event.type, type);
  });
});

test('모달이 열리면 배경 게임의 입력과 새 이벤트를 차단한다', () => {
  for (const type of ['captcha', 'ad', 'bsod', 'maintenance', 'consent']) {
    const { game } = setup();
    game.triggerEvent(type);
    assert.equal(game.press(), false);
    assert.equal(game.getSnapshot().count, 0);
    assert.equal(game.triggerEvent('tape'), false);
    assert.equal(game.getSnapshot().event.type, type);
  }
});

test('BSOD는 1초, 점검과 클럽은 3초 뒤에 해제된다', () => {
  for (const [type, duration] of [['bsod', 1000], ['maintenance', 3000], ['disco', 3000]]) {
    const { game, advance } = setup();
    game.triggerEvent(type);
    assert.equal(game.dismissEvent(), type === 'disco');
    if (type === 'disco') game.triggerEvent(type);
    advance(duration - 1);
    assert.equal(game.getSnapshot().event.type, type);
    advance(1);
    assert.equal(game.getSnapshot().event, null);
  }
});

test('파리·순간이동·착시가 시간이 지나면 사라진다', () => {
  for (const type of ['fly', 'escape', 'invert']) {
    const { game, advance } = setup();
    game.triggerEvent(type);
    advance(6000);
    assert.equal(game.getSnapshot().event, null);
  }
});

test('초기화가 모든 예약 작업과 방해 효과를 제거한다', () => {
  const { game, advance, tasks } = setup();
  game.press();
  game.triggerEvent('disco');
  assert.ok(tasks.size > 0);
  game.reset();
  assert.equal(tasks.size, 0);
  advance(10000);
  const state = game.getSnapshot();
  assert.equal(state.count, 0);
  assert.equal(state.anger, 0);
  assert.equal(state.lit, true);
  assert.equal(state.event, null);
  assert.equal(state.candle, false);
});

test('모델 종료 후 예약 콜백과 입력이 실행되지 않는다', () => {
  const { game, tasks, changes } = setup();
  game.press();
  const before = changes.length;
  game.destroy();
  assert.equal(tasks.size, 0);
  assert.equal(game.press(), false);
  assert.equal(changes.length, before);
});

test('잘못된 이벤트는 거부하고 이벤트 종료 후 재입력이 가능하다', () => {
  const { game } = setup();
  assert.equal(game.triggerEvent('not-an-event'), false);
  assert.equal(game.triggerEvent('ad'), true);
  assert.equal(game.dismissEvent(), true);
  assert.equal(game.press(), true);
});

test('HTML은 외부 리소스나 음성 합성에 의존하지 않는다', () => {
  const { html } = setup();
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|@import|speechSynthesis|SpeechSynthesisUtterance|fetch\(/i);
  assert.match(html, /name="viewport"/);
  assert.match(html, /AudioContext/);
  assert.match(html, /prefers-reduced-motion/);
});

test('기본 타이머가 브라우저의 호출 컨텍스트 제약을 지킨다', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const script = html.match(/<script id="game-code">([\s\S]*?)<\/script>/)[1];
  let scheduled = 0;
  let cancelled = 0;
  function browserSetTimeout() {
    if (this && typeof this.press === 'function') throw new TypeError('Illegal invocation');
    scheduled++;
    return scheduled;
  }
  function browserClearTimeout() {
    if (this && typeof this.press === 'function') throw new TypeError('Illegal invocation');
    cancelled++;
  }
  const sandbox = { module: { exports: {} }, setTimeout: browserSetTimeout, clearTimeout: browserClearTimeout, Date, Math };
  vm.runInNewContext(script, sandbox);
  const game = new sandbox.module.exports.SwitchGame({ random: () => 0.99 });
  assert.doesNotThrow(() => game.press());
  assert.equal(scheduled, 1);
  assert.doesNotThrow(() => game.reset());
  assert.equal(cancelled, 1);
});

test('100%가 되기 전에는 시간 제한 없이 분노를 유지한다', () => {
  const { game, advance } = setup();
  game.press();
  advance(120000);
  const state = game.getSnapshot();
  assert.equal(state.anger, 1);
  assert.equal(state.stage, 1);
  assert.equal(state.count, 1);
  assert.equal(state.stats.money, '0.0004');
  assert.equal(state.calmRemainingMs, 0);
  assert.equal(state.lastReport, null);
});

test('100%에 도달한 순간부터 정확히 30초 뒤에 분노가 초기화된다', () => {
  const { game, advance, reachCandle } = setup();
  reachCandle();
  assert.equal(game.getSnapshot().calmRemainingMs, 30000);
  advance(29999);
  assert.equal(game.getSnapshot().anger, 100);
  assert.equal(game.getSnapshot().lastReport, null);
  advance(1);
  assert.equal(game.getSnapshot().anger, 0);
  assert.equal(game.getSnapshot().lastReport.clicks, 100);
});

test('촛불 모드에서 반복 클릭해도 30초 타이머를 연장하지 않는다', () => {
  const { game, advance, reachCandle } = setup();
  reachCandle(); advance(15000);
  game.press();
  advance(14999);
  assert.equal(game.getSnapshot().anger, 100);
  advance(1);
  assert.equal(game.getSnapshot().anger, 0);
  assert.equal(game.getSnapshot().count, 101);
});

test('30초 후 촛불을 치우고 다음 클릭은 타이머 없이 1%부터 시작한다', () => {
  const { game, reachCandle, advance } = setup();
  reachCandle();
  assert.equal(game.getSnapshot().candle, true);
  advance(30000);
  const calm = game.getSnapshot();
  assert.equal(calm.anger, 0);
  assert.equal(calm.candle, false);
  assert.equal(calm.lit, true);
  assert.equal(calm.count, 100);
  assert.equal(game.press(), true);
  assert.equal(game.getSnapshot().anger, 1);
  assert.equal(game.getSnapshot().calmRemainingMs, 0);
  advance(60000);
  assert.equal(game.getSnapshot().anger, 1);
});

test('예약된 사과가 촛불 도달 후 30초 마감을 연장하지 않는다', () => {
  const { game, click, advance, changes } = setup();
  click(99); game.apologize(); game.press(); advance(180); game.press();
  assert.equal(game.getSnapshot().calmRemainingMs, 30000);
  advance(30000);
  assert.equal(game.getSnapshot().anger, 0);
  assert.equal(game.getSnapshot().lit, true);
  const afterCalm = changes.length;
  advance(1000);
  assert.equal(changes.length, afterCalm);
});

test('재시작은 이전 30초 타이머를 취소하고 다음 100%에서 새로 센다', () => {
  const { game, advance, reachCandle, click } = setup();
  reachCandle(); advance(15000);
  game.reset();
  advance(10000);
  game.press();
  advance(20000);
  assert.equal(game.getSnapshot().anger, 1);
  click(99);
  advance(game.getSnapshot().calmRemainingMs);
  assert.equal(game.getSnapshot().anger, 0);
});

test('실제 마우스·터치 클릭을 받고 키보드와 프로그램 클릭을 거부한다', () => {
  const { isDirectPointerClick } = setup();
  assert.equal(typeof isDirectPointerClick, 'function');
  const mouse = { type: 'click', isTrusted: true, detail: 1, pointerType: 'mouse' };
  const touch = { type: 'click', isTrusted: true, detail: 0, pointerType: 'touch' };
  const legacyTouch = { type: 'click', isTrusted: true, detail: 1 };
  const keyboard = { type: 'click', isTrusted: true, detail: 0, pointerType: '' };
  const scripted = { ...mouse, isTrusted: false };
  assert.equal(isDirectPointerClick(mouse), true);
  assert.equal(isDirectPointerClick(touch), true);
  assert.equal(isDirectPointerClick(legacyTouch), true);
  assert.equal(isDirectPointerClick(keyboard), false);
  assert.equal(isDirectPointerClick(scripted), false);
  assert.equal(isDirectPointerClick({ ...mouse, type: 'keydown' }), false);
});

test('불을 복구할 때 스탠드·냉장고·전등이 순환하고 끄는 동안 모두 꺼진다', () => {
  const { game, advance } = setup();
  assert.equal(game.getSnapshot().lightSource, 'ceiling');
  for (const source of ['lamp', 'fridge', 'ceiling', 'lamp']) {
    game.press();
    assert.equal(game.getSnapshot().lightSource, 'none');
    advance(600);
    assert.equal(game.getSnapshot().lightSource, source);
    assert.equal(game.getSnapshot().lit, true);
  }
});

test('청구서는 성공한 끄기마다 300원을 부과하며 테이프 실패는 무료다', () => {
  const { game, advance } = setup();
  game.press();
  assert.equal(game.getSnapshot().stats.repair, 300);
  assert.equal(game.getSnapshot().stats.balance, '-299.9996');
  game.press();
  assert.equal(game.getSnapshot().stats.repair, 300);
  advance(600);
  game.triggerEvent('tape');
  game.press(); game.press();
  assert.equal(game.getSnapshot().stats.repair, 300);
  game.press();
  assert.equal(game.getSnapshot().stats.repair, 600);
  assert.equal(game.getSnapshot().stats.balance, '-599.9992');
});

test('포인트는 실제 끄기 성공에만 1점씩 적립된다', () => {
  const { game, advance } = setup();
  game.triggerEvent('tape');
  game.press(); game.press();
  assert.equal(game.getSnapshot().points, 0);
  game.press(); game.press();
  assert.equal(game.getSnapshot().points, 1);
  advance(600); game.press();
  assert.equal(game.getSnapshot().points, 2);
});

test('황금 스위치는 999,999P가 있어야 한 번만 구매되며 게임 성능은 그대로다', () => {
  const { game, click, advance } = setup();
  assert.equal(typeof game.buyGolden, 'function');
  assert.equal(game.buyGolden(), false);
  click(30);
  assert.equal(game.buyGolden(), false);
  game.points = 999998;
  assert.equal(game.buyGolden(), false);
  game.points = 999999;
  const before = game.getSnapshot();
  assert.equal(game.buyGolden(), true);
  const after = game.getSnapshot();
  assert.equal(after.points, 0);
  assert.equal(after.golden, true);
  assert.equal(after.count, before.count);
  assert.equal(after.anger, before.anger);
  assert.equal(after.stats.repair, before.stats.repair);
  assert.equal(after.calmRemainingMs, before.calmRemainingMs);
  assert.equal(game.buyGolden(), false);
  game.press(); advance(180);
  assert.equal(game.getSnapshot().lit, true);
  assert.equal(game.getSnapshot().count, 31);
  assert.equal(game.getSnapshot().points, 1);
});

test('사과하면 1% 내려갔다가 450ms 뒤 6% 오르고 처리 중 중복 사과는 막는다', () => {
  const { game, advance } = setup();
  assert.equal(typeof game.apologize, 'function');
  assert.equal(game.apologize(), false);
  game.press(); advance(600);
  const remaining = game.getSnapshot().calmRemainingMs;
  assert.equal(game.apologize(), true);
  assert.equal(game.getSnapshot().anger, 0);
  assert.equal(game.getSnapshot().apologyPending, true);
  assert.equal(game.apologize(), false);
  assert.equal(game.getSnapshot().calmRemainingMs, remaining);
  advance(449);
  assert.equal(game.getSnapshot().anger, 0);
  advance(1);
  assert.equal(game.getSnapshot().anger, 6);
  assert.equal(game.getSnapshot().apologyPending, false);
  assert.equal(game.getSnapshot().apologies, 1);
  assert.equal(game.getSnapshot().count, 1);
  assert.equal(game.getSnapshot().points, 1);
});

test('사과의 역효과도 분노 100%에 도달하면 촛불을 켠다', () => {
  const { game, click, advance } = setup();
  click(99);
  game.apologize(); advance(450);
  assert.equal(game.getSnapshot().anger, 100);
  assert.equal(game.getSnapshot().candle, true);
  assert.equal(game.getSnapshot().lightSource, 'candle');
  assert.equal(game.getSnapshot().count, 99);
  assert.equal(game.getSnapshot().calmRemainingMs, 30000);
  assert.equal(game.apologize(), false);
});

test('사과로 잠깐 0%가 되어도 기록은 유지하고 타이머는 100%까지 대기한다', () => {
  const { game, advance } = setup();
  game.press(); advance(600);
  game.apologize();
  assert.equal(game.getSnapshot().anger, 0);
  assert.equal(game.getSnapshot().lastReport, null);
  assert.equal(game.getSnapshot().calmRemainingMs, 0);
  advance(450); game.press();
  assert.equal(game.getSnapshot().anger, 7);
  assert.equal(game.getSnapshot().count, 2);
});

test('모달 및 종료된 게임에서는 상점과 사과를 실행할 수 없다', () => {
  const { game, click } = setup();
  assert.equal(typeof game.apologize, 'function');
  assert.equal(typeof game.buyGolden, 'function');
  click(30); game.points = 999999; game.triggerEvent('ad');
  assert.equal(game.apologize(), false);
  assert.equal(game.buyGolden(), false);
  assert.equal(game.getSnapshot().points, 999999);
  game.dismissEvent(); game.destroy();
  assert.equal(game.apologize(), false);
  assert.equal(game.buyGolden(), false);
});

test('첫 클릭과 적자 업적은 조건을 만족할 때 한 번씩만 획득한다', () => {
  const { game, click, changes } = setup();
  click(10);
  const state = game.getSnapshot();
  assert.ok(Array.isArray(state.achievements));
  assert.ok(state.achievements.includes('first'));
  assert.ok(state.achievements.includes('broke'));
  click(1);
  const awarded = changes.flatMap(change => Array.from(change.message.unlocked || []));
  assert.equal(awarded.filter(id => id === 'first').length, 1);
  assert.equal(awarded.filter(id => id === 'broke').length, 1);
});

test('테이프 업적은 세 번 눌러 실제 제거한 시점에만 열린다', () => {
  const { game } = setup();
  game.triggerEvent('tape'); game.press(); game.press();
  assert.ok(Array.isArray(game.getSnapshot().achievements));
  assert.equal(game.getSnapshot().achievements.includes('tape'), false);
  game.press();
  assert.equal(game.getSnapshot().achievements.includes('tape'), true);
});

test('황금·사과·해탈·30초·100회 업적에는 해당 조건이 필요하다', () => {
  const { game, click, advance } = setup();
  click(30); buyGoldenForFixture(game); game.apologize(); advance(450);
  click(65);
  assert.ok(game.getSnapshot().achievements.includes('golden'));
  assert.ok(game.getSnapshot().achievements.includes('apology'));
  assert.ok(game.getSnapshot().achievements.includes('candle'));
  advance(game.getSnapshot().calmRemainingMs);
  assert.ok(game.getSnapshot().achievements.includes('minute'));
  click(5);
  assert.ok(game.getSnapshot().achievements.includes('hundred'));
  assert.equal(game.getSnapshot().achievements.length, 7);
});

test('100% 이후 30초 성적표가 해당 주기의 클릭·사과·최고 분노·적자를 기록한다', () => {
  const { game, advance, click } = setup();
  game.press(); advance(600);
  assert.equal(typeof game.apologize, 'function');
  game.apologize(); advance(450); click(94);
  advance(game.getSnapshot().calmRemainingMs - 1);
  assert.equal(game.getSnapshot().lastReport, null);
  advance(1);
  const state = game.getSnapshot();
  const report = state.lastReport;
  assert.equal(report.number, 1);
  assert.equal(report.clicks, 95);
  assert.equal(report.apologies, 1);
  assert.equal(report.peakAnger, 100);
  assert.equal(report.repair, 28500);
  assert.equal(report.saved, '0.0380');
  assert.equal(report.balance, '-28499.9620');
  assert.equal(report.finalLight, '켜짐');
  assert.equal(report.verdict, '집주인 승');
  assert.equal(state.anger, 0);
  assert.equal(state.count, 95);
});

test('새 주기의 성적표는 누적 클릭과 분리하고 구매·포인트·업적은 보존한다', () => {
  const { game, click, advance } = setup();
  click(30); buyGoldenForFixture(game); click(70); advance(game.getSnapshot().calmRemainingMs);
  assert.equal(game.getSnapshot().lastReport.clicks, 100);
  assert.equal(game.getSnapshot().golden, true);
  assert.equal(game.getSnapshot().points, 70);
  click(105); advance(game.getSnapshot().calmRemainingMs);
  const state = game.getSnapshot();
  assert.equal(state.lastReport.number, 2);
  assert.equal(state.lastReport.clicks, 105);
  assert.equal(state.lastReport.repair, 31500);
  assert.equal(state.count, 205);
  assert.equal(state.stats.repair, 61500);
  assert.equal(state.golden, true);
  assert.equal(state.points, 175);
  assert.ok(state.achievements.includes('golden'));
});

test('재시작은 구매·포인트·업적·성적표·예약된 사과까지 초기화한다', () => {
  const { game, click, advance, tasks } = setup();
  click(100); buyGoldenForFixture(game); advance(game.getSnapshot().calmRemainingMs);
  click(1); game.apologize();
  game.reset(); advance(60000);
  const state = game.getSnapshot();
  assert.equal(state.points, 0);
  assert.equal(state.golden, false);
  assert.equal(state.achievements.length, 0);
  assert.equal(state.lastReport, null);
  assert.equal(state.apologies, 0);
  assert.equal(state.apologyPending, false);
  assert.equal(state.lightSource, 'ceiling');
  assert.equal(state.stats.repair, 0);
  assert.equal(tasks.size, 0);
  click(100); advance(game.getSnapshot().calmRemainingMs);
  assert.equal(game.getSnapshot().lastReport.number, 1);
});

test('촛불은 4단계에 도달해야만 끌 수 있다', () => {
  const { game, reachCandle } = setup();
  assert.equal(typeof game.extinguishCandle, 'function');
  assert.equal(game.extinguishCandle(), false);
  reachCandle();
  assert.equal(game.getSnapshot().stage, 4);
  assert.equal(game.extinguishCandle(), true);
});

test('촛불을 끄면 5단계 암전으로 진입하며 게임 입력과 새 방해를 막는다', () => {
  const { game, reachCandle } = setup();
  assert.equal(typeof game.extinguishCandle, 'function');
  reachCandle();
  const before = game.getSnapshot();
  game.extinguishCandle();
  const state = game.getSnapshot();
  assert.equal(state.stage, 5);
  assert.equal(state.blackout, true);
  assert.equal(state.candle, false);
  assert.equal(state.lit, false);
  assert.equal(state.lightSource, 'none');
  assert.equal(state.count, before.count);
  assert.equal(state.points, before.points);
  assert.equal(game.press(), false);
  assert.equal(game.apologize(), false);
  game.points = 999999;
  assert.equal(game.buyGolden(), false);
  assert.equal(game.triggerEvent('disco'), false);
  assert.equal(game.extinguishCandle(), false);
});

test('암전은 진행 중인 조명 효과를 취소하고 30초 마감 예약만 남긴다', () => {
  const { game, reachCandle, advance, changes, tasks } = setup();
  assert.equal(typeof game.extinguishCandle, 'function');
  reachCandle(); game.triggerEvent('disco'); game.extinguishCandle();
  assert.equal(game.getSnapshot().event, null);
  assert.equal(tasks.size, 1);
  const before = changes.length;
  advance(3000);
  assert.equal(changes.length, before);
  assert.equal(game.getSnapshot().stage, 5);
  assert.equal(game.getSnapshot().lit, false);
});

test('방해 팝업을 닫기 전에는 촛불 끄기가 실행되지 않는다', () => {
  const { game, reachCandle } = setup();
  assert.equal(typeof game.extinguishCandle, 'function');
  reachCandle(); game.triggerEvent('ad');
  assert.equal(game.extinguishCandle(), false);
  assert.equal(game.getSnapshot().stage, 4);
  game.dismissEvent();
  assert.equal(game.extinguishCandle(), true);
});

test('암전도 기존 30초 마감에 복귀하며 성적표에 꺼짐과 당신 승을 기록한다', () => {
  const { game, reachCandle, advance } = setup();
  assert.equal(typeof game.extinguishCandle, 'function');
  reachCandle(); advance(10000); game.extinguishCandle();
  assert.equal(game.getSnapshot().calmRemainingMs, 20000);
  advance(19999);
  assert.equal(game.getSnapshot().stage, 5);
  advance(1);
  const state = game.getSnapshot();
  assert.equal(state.stage, 1);
  assert.equal(state.anger, 0);
  assert.equal(state.blackout, false);
  assert.equal(state.lit, true);
  assert.equal(state.lightSource, 'ceiling');
  assert.equal(state.count, 100);
  assert.equal(state.lastReport.finalLight, '꺼짐');
  assert.equal(state.lastReport.verdict, '당신 승');
  assert.equal(game.press(), true);
  assert.equal(game.getSnapshot().anger, 1);
  assert.equal(game.getSnapshot().calmRemainingMs, 0);
});

test('전체 초기화는 암전과 예약 타이머까지 해제한다', () => {
  const { game, reachCandle, advance, tasks } = setup();
  assert.equal(typeof game.extinguishCandle, 'function');
  reachCandle(); game.extinguishCandle(); game.reset(); advance(30000);
  assert.equal(game.getSnapshot().blackout, false);
  assert.equal(game.getSnapshot().stage, 1);
  assert.equal(game.getSnapshot().count, 0);
  assert.equal(game.getSnapshot().lastReport, null);
  assert.equal(tasks.size, 0);
});
