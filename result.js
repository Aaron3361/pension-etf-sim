/*
 * 웹 사이트 결과 화면 (19장): 주소 # 뒤의 선택값 → data/{성향}.json + sim.js로 대시보드 데이터를 만든 뒤
 * 대시보드 그리기 코드(dashboard.py와 같은 것, <script type="text/plain" id="dash-js">)를 실행합니다.
 * 금액은 # 뒤에만 있어 서버(GitHub Pages)로 전송되지 않습니다.
 */
(function () {
  'use strict';
  var RISKS = ['very_conservative', 'conservative', 'moderate', 'aggressive', 'very_aggressive'];
  var ACCTS = ['pension_irp', 'pension_saving', 'general'];
  function parse() {
    var o = {};
    location.hash.slice(1).split('&').forEach(function (kv) { var p = kv.split('='); if (p[0]) o[p[0]] = decodeURIComponent(p[1] || ''); });
    var inp = { account: o.a, capital: +o.c, monthly: +o.m || 0, risk: o.r, years: +o.y || 10, target: +o.t || 0 };
    var ok = ACCTS.indexOf(inp.account) >= 0 && RISKS.indexOf(inp.risk) >= 0 && inp.capital >= 100000 && inp.capital <= 1e11 &&
             inp.monthly >= 0 && inp.monthly <= 1e9 && [5, 10, 20, 30].indexOf(inp.years) >= 0 && inp.target >= 0;
    return ok ? inp : null;
  }
  function fail(msg) {
    document.querySelector('.wrap').insertAdjacentHTML('afterbegin',
      '<div class="card" style="margin-top:24px"><h3 class="ctitle">' + msg + '</h3><a class="cta" href="index.html" style="text-decoration:none;text-align:center">처음부터 고르기</a></div>');
  }
  // 진행 표시 (결과 화면이 열리자마자 보이는 '계산 중' 화면, build_site.result_page가 넣어 둠)
  var STEPS = document.querySelectorAll('#ldSteps li');
  function progress(step, pct, title) {
    STEPS.forEach(function (li, i) { li.className = i < step ? 'done' : (i === step ? 'now' : ''); });
    document.getElementById('ldBar').style.width = pct + '%';
    if (title) document.getElementById('ldTitle').textContent = title;
  }
  function done() { var l = document.getElementById('loading'); l.classList.add('out'); setTimeout(function () { l.remove(); }, 300); }
  function later(fn) { return new Promise(function (res) { setTimeout(function () { res(fn()); }, 30); }); }   // 화면이 진행 상황을 그릴 틈

  var inp = parse();
  if (!inp) { done(); fail('선택한 조건을 읽지 못했어요.'); return; }
  var yearsLi = document.getElementById('ldYears'); if (yearsLi) yearsLi.textContent = '앞으로 ' + inp.years + '년 5,000번 계산';
  progress(0, 8, '자료를 불러오고 있어요');
  fetch('data/' + inp.risk + '.json').then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (data) {
    var out = { meta: SIM.buildMeta(data, inp), modes: [] }, n = data.modes.length;
    var chain = Promise.resolve();
    data.modes.forEach(function (t, i) {
      chain = chain.then(function () {
        progress(i === 0 ? 1 : 2, 20 + Math.round(65 * i / n), t.short + ' 계좌 계산 중 (' + (i + 1) + ' / ' + n + ')');
        return later(function () { out.modes.push(SIM.buildMode(data, t, inp)); });
      });
    });
    return chain.then(function () { progress(3, 92, '화면을 그리고 있어요'); return later(function () { return out; }); });
  }).then(function (out) {
    document.getElementById('meta-data').textContent = JSON.stringify(out.meta);
    document.getElementById('modes-data').textContent = JSON.stringify(out.modes);
    document.querySelector('.tabs').innerHTML = out.modes.map(function (m) {
      return "<button type='button' role='tab' class='mode-btn' data-key='" + m.key + "' aria-selected='false'>" + m.short + '</button>'; }).join('');
    // 표현 원칙(19-5): '사세요' 대신 '모델이 계산한 예시 구성'
    var t = document.querySelector('[data-acc="buy"] .acc-t'); if (t) t.textContent = '모델이 계산한 예시 구성';
    // 조건 바꾸기 · 결과 링크 복사
    document.querySelector('.top').insertAdjacentHTML('afterend',
      '<p class="webbar"><a href="index.html' + location.hash + '">← 조건 바꾸기</a><button type="button" id="copyLink">결과 링크 복사</button></p>');
    document.getElementById('copyLink').addEventListener('click', function (e) {
      var b = e.currentTarget, done = function () { b.textContent = '복사됨'; setTimeout(function () { b.textContent = '결과 링크 복사'; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, function () {}); });
    try { localStorage.setItem('dashboard-mode', inp.account); } catch (e) {}
    var s = document.createElement('script');
    s.textContent = document.getElementById('dash-js').textContent;
    document.body.appendChild(s);
    progress(4, 100, '완료');
    done();
  }).catch(function () { done(); fail('자료를 불러오지 못했어요. 잠시 후 다시 시도하세요.'); });
  window.addEventListener('hashchange', function () { location.reload(); });
})();
