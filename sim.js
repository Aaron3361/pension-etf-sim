/*
 * 웹 사이트(implementation_plan.md 19장): 방문자 브라우저에서 하는 계산
 * - 미리 계산해 둔 성향별 결과(data/{성향}.json)에 방문자가 고른 금액·적립·기간·목표를 넣어 대시보드 데이터를 다시 만듭니다.
 * - 1주 단위 매수: allocator.py와 같은 규칙 (목표 금액 // 가격, 남는 돈은 반 주 이상 부족한 종목에 1주씩)
 * - 앞으로 N년: monte_carlo.py와 같은 방식 (월 기대수익·흔들림 + 자유도 5 t분포 난수, 5,000번)
 * - 세액공제·남는 현금: dashboard.py · deposit_finder.py와 같은 규칙
 * 키·계좌 정보는 쓰지 않습니다.
 */
(function (root) {
  'use strict';
  var RISKY = ['주식', '리츠', '원자재'];
  var CLASS_ORDER = ['주식', '채권', '리츠', '원자재', '현금성'];
  var ANNUAL_DEPOSIT_LIMIT = 18000000;
  var TAX_CREDIT_RATES = [['총급여 5,500만원 이하', 0.165], ['총급여 5,500만원 초과', 0.132]];
  var SIM_TAX_RATE = 0.132, T_DOF = 5, N_SIM = 5000, INFLATION = 0.02;
  var INTEREST_TAX = 0.154, PROTECT_LIMIT = 100000000, SMALL_INTEREST = 5000, REBALANCE_MONTHS = 3;
  var TERMS = [1, 3, 6, 12, 24, 36];

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function normalGen(rand) {
    var spare = null;
    return function () {
      if (spare !== null) { var v = spare; spare = null; return v; }
      var u = 0, w = 0;
      while (u === 0) u = rand();
      w = rand();
      var r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * w);
      return r * Math.cos(2 * Math.PI * w);
    };
  }
  function percentile(sorted, p) {   // numpy 기본(선형 보간)과 같음
    var idx = p / 100 * (sorted.length - 1), lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  // ── 1주 단위 매수 (allocator.py) ──
  function allocate(holdings, classTargetPct, capital) {
    var rows = holdings.filter(function (h) { return h.price > 0 && h.w > 0; }).map(function (h) {
      var target = Math.floor(capital * h.w);
      return Object.assign({}, h, { target: target, qty: Math.floor(target / h.price) });
    });
    var classCap = {};
    CLASS_ORDER.forEach(function (c) { classCap[c] = Math.floor(capital * (classTargetPct[c] || 0) / 100); });
    var residual = capital - rows.reduce(function (a, r) { return a + r.qty * r.price; }, 0);
    for (;;) {
      var classHeld = {};
      rows.forEach(function (r) { classHeld[r.cls] = (classHeld[r.cls] || 0) + r.qty * r.price; });
      var best = -1, bestScore = -Infinity;
      rows.forEach(function (r, i) {
        var gap = r.target - r.qty * r.price, room = (classCap[r.cls] || 0) - classHeld[r.cls];
        var ok = gap >= 0.5 * r.price && r.price <= residual && (RISKY.indexOf(r.cls) < 0 || r.price <= room);
        if (ok && gap / r.price > bestScore) { bestScore = gap / r.price; best = i; }
      });
      if (best < 0) break;
      rows[best].qty += 1;
      residual -= rows[best].price;
    }
    var bought = rows.filter(function (r) { return r.qty > 0; }).map(function (r) {
      var amount = Math.floor(r.qty * r.price);
      return { cls: r.cls, name: r.name, ticker: r.ticker, qty: r.qty, amount: amount, pct: amount / capital * 100,
               domestic: r.domestic, unconfirmed: r.unconfirmed, price: r.price, w: r.w };
    });
    var invested = bought.reduce(function (a, r) { return a + r.amount; }, 0);
    return { holdings: bought, invested: invested, cash: capital - invested, dropped: rows.length - bought.length };
  }

  // ── 목표 금액 기본값 (monte_carlo.default_target) ──
  function defaultTarget(capital, monthly, years) {
    var months = years * 12, m = Math.pow(1 + INFLATION, 1 / 12) - 1;
    var deposits = m ? monthly * ((Math.pow(1 + m, months) - 1) / m) : monthly * months;
    return Math.round((capital * Math.pow(1 + m, months) + deposits) / 1e4) * 1e4;   // 파이썬 round(…, -4)
  }

  // ── 앞으로 N년 (monte_carlo.run_monte_carlo) ──
  function monteCarlo(o) {
    var months = o.years * 12, monthly = o.monthly;
    if (o.depositLimit && monthly * 12 > o.depositLimit) monthly = Math.floor(o.depositLimit / 12);
    var refund = o.taxRate * Math.min(monthly * 12, o.taxLimit || 0);
    var drift = o.mean - 0.5 * o.var, vol = Math.sqrt(Math.max(o.var, 1e-12));
    var norm = normalGen(mulberry32(42)), scale = Math.sqrt(T_DOF / (T_DOF - 2));
    var step = months > 36 ? 3 : 1, cols = [];
    for (var mo = 0; mo <= months; mo += step) cols.push(mo);
    var paths = cols.map(function () { return new Float64Array(N_SIM); });
    var finals = new Float64Array(N_SIM), finalsNo = new Float64Array(N_SIM);
    for (var s = 0; s < N_SIM; s++) {
      var v = o.capital, vn = o.capital, ci = 0;
      paths[ci++][s] = v;
      for (var t = 1; t <= months; t++) {
        var z = norm(), chi = 0;
        for (var k = 0; k < T_DOF; k++) { var x = norm(); chi += x * x; }
        var shock = z / Math.sqrt(chi / T_DOF) / scale;
        var r = Math.exp(drift + vol * shock);
        v = (v + monthly) * r + (t % 12 === 0 ? refund : 0);
        vn = (vn + monthly) * r;
        if (ci < cols.length && cols[ci] === t) paths[ci++][s] = v;
      }
      finals[s] = v; finalsNo[s] = vn;
    }
    var q = { p10: [], p50: [], p90: [] };
    paths.forEach(function (col) {
      col.sort();
      q.p10.push(Math.floor(percentile(col, 10))); q.p50.push(Math.floor(percentile(col, 50))); q.p90.push(Math.floor(percentile(col, 90)));
    });
    var sortedF = Float64Array.from(finals).sort(), sortedN = Float64Array.from(finalsNo).sort();
    var principalTotal = o.capital + monthly * months;
    var success = 0, below = 0;
    for (var i = 0; i < N_SIM; i++) { if (finals[i] >= o.target) success++; if (finals[i] < principalTotal) below++; }
    return {
      years: o.years, success: +(success / N_SIM * 100).toFixed(2), target: o.target,
      expRet: +((Math.pow(1 + o.mean, 12) - 1) * 100).toFixed(2), deposit: monthly,
      final: { p10: Math.floor(percentile(sortedF, 10)), p50: Math.floor(percentile(sortedF, 50)), p90: Math.floor(percentile(sortedF, 90)) },
      below: +(below / N_SIM * 100).toFixed(2), principalTotal: principalTotal,
      targetDefault: o.target === defaultTarget(o.capital, o.monthly, o.years),
      chart: { labels: cols, p10: q.p10, p50: q.p50, p90: q.p90, principal: cols.map(function (mo) { return Math.floor(o.capital + monthly * mo); }) },
      annualRefund: Math.floor(refund), medianFinal: Math.floor(percentile(sortedF, 50)), medianNoCredit: Math.floor(percentile(sortedN, 50))
    };
  }

  // ── 세액공제 (dashboard._tax_credit) ──
  function taxCredit(taxLimit, monthly, mc) {
    var annual = monthly ? Math.min(monthly * 12, ANNUAL_DEPOSIT_LIMIT) : taxLimit, base = Math.min(annual, taxLimit);
    var out = { example: !monthly, monthly: monthly, annual: annual, limit: taxLimit, base: base,
                refunds: TAX_CREDIT_RATES.map(function (r) { return { label: r[0], rate: r[1], amount: base * r[1] }; }) };
    if (mc.annualRefund) out.reinvest = { rate: SIM_TAX_RATE, refund: mc.annualRefund, years: mc.years, 'with': mc.medianFinal, without: mc.medianNoCredit };
    return out;
  }

  // ── 남는 현금 (deposit_finder.cash_plan) — deposits = data의 예적금 목록(없으면 null) ──
  function pickTerm(months) { var t = TERMS.filter(function (x) { return x <= months; }); return t.length ? t[t.length - 1] : TERMS[0]; }
  function interest(amount, rate, months, type) {
    var r = rate / 100, gross = type === 'M' ? amount * (Math.pow(1 + r / 12, months) - 1) : amount * r * months / 12;
    gross = Math.floor(gross);
    return { gross: gross, net: gross - Math.floor(gross * INTEREST_TAX / 10) * 10 };
  }
  function rankDeposits(dep, amount, months) {
    if (!dep || amount <= 0) return [];
    var term = pickTerm(months), seen = {}, rows = [];
    dep.products.forEach(function (p) {
      if (p.kind !== 'deposit' || p.join_deny !== '1') return;
      if (p.max_limit && +p.max_limit < amount) return;
      var opts = p.options.filter(function (o) { return o.term === term; });
      if (!opts.length) return;
      var o = opts.sort(function (a, b) { return b.rate - a.rate; })[0], it = interest(amount, o.rate, term, o.type);
      rows.push({ company: p.company, name: p.name, group: p.group, term: term, rate: o.rate, rateMax: o.rate_max,
                  rateType: o.type === 'M' ? '복리' : '단리', joinWay: p.join_way, special: (p.special || '').trim().slice(0, 200), gross: it.gross, net: it.net });
    });
    rows.sort(function (a, b) { return b.rate - a.rate || (b.rateMax || 0) - (a.rateMax || 0) || (a.company < b.company ? -1 : 1); });
    return rows.filter(function (r) { if (seen[r.company]) return false; seen[r.company] = 1; return true; }).slice(0, 10);
  }
  function cashPlan(modeKey, residual, blocked, monthly, dep) {
    var account = modeKey === 'general' ? 'general' : (modeKey === 'pension_irp' ? 'irp' : 'saving');
    var inside = account === 'general', items = [];
    function item(kind, label, amount, months, bank) {
      var it = { kind: kind, label: label, amount: Math.floor(amount), months: months, term: pickTerm(months) };
      if (bank) {
        var top = rankDeposits(dep, amount, months), left = amount, split = [];
        it.top = top; it.small = !!top.length && top[0].net < SMALL_INTEREST;
        if (amount > PROTECT_LIMIT * 0.9) top.forEach(function (r) {
          if (left <= 0) return;
          var cap = Math.floor(PROTECT_LIMIT / (1 + r.rate / 100 * r.term / 12) / 10000) * 10000, put = Math.min(left, cap);
          split.push({ company: r.company, name: r.name, amount: Math.floor(put) }); left -= put;
        });
        it.split = split;
      }
      return it;
    }
    if (residual >= 1) items.push(item('residual', '1주 단위로 사고 남은 돈', residual, REBALANCE_MONTHS, inside));
    if (blocked >= 1) items.push(item('blocked', '연금 편입 확인 전이라 매수가 막힌 돈', blocked, 1, inside));
    if (monthly >= 1) items.push(item('monthly', '매달 넣는 적립금 (다음 매수까지)', monthly, 1, inside));
    if (!items.length) return null;
    var range = null;
    if (account === 'irp' && dep) {
      var rates = [];
      dep.products.forEach(function (p) { if (p.kind === 'deposit' && p.group === '은행' && p.join_deny === '1') p.options.forEach(function (o) { if (o.term === 3) rates.push(o.rate); }); });
      if (rates.length) range = { term: 3, min: Math.min.apply(null, rates), max: Math.max.apply(null, rates) };
    }
    return { account: account, items: items, source: dep ? { month: dep.month, fetched: dep.fetched } : null, range: range };
  }

  // ── 성향별 미리 계산 결과 + 방문자 입력 → 대시보드 데이터 ──
  function buildMeta(data, inp) {
    var meta = Object.assign({}, data.meta, { capital: inp.capital, monthly: inp.monthly, web: true });
    meta.defaultKey = inp.account;
    return meta;
  }
  function buildMode(data, t, inp) {   // 계좌(탭) 하나: 1주 단위 수량 → 앞으로 N년 → 세액공제 → 남는 현금
      var m = JSON.parse(JSON.stringify(t));
      var a = allocate(t.holdings, t.target || {}, inp.capital);
      m.holdings = a.holdings; m.invested = a.invested; m.cash = a.cash; m.count = a.holdings.length; m.dropped = a.dropped;
      m.classes = CLASS_ORDER.map(function (c) { return { cls: c, pct: a.holdings.filter(function (h) { return h.cls === c; }).reduce(function (s, h) { return s + h.pct; }, 0) }; });
      m.risky = a.holdings.filter(function (h) { return RISKY.indexOf(h.cls) >= 0; }).reduce(function (s, h) { return s + h.pct; }, 0);
      m.cmd = null;
      var cashW = a.cash / inp.capital, p = t.mcp || {}, inv0 = 1 - (p.cash || 0);
      var rfM = (data.meta.rf || 0.03) / 12, muInv = inv0 > 0 ? ((p.mean || 0) - rfM * (p.cash || 0)) / inv0 : 0;
      var volInv = inv0 > 0 ? Math.sqrt(p['var'] || 0) / inv0 : 0;
      var cons = t.cons || {}, target = inp.target || defaultTarget(inp.capital, inp.monthly, inp.years);
      var mc = monteCarlo({ capital: inp.capital, monthly: inp.monthly, years: inp.years, target: target,
                            mean: muInv * (1 - cashW) + rfM * cashW, 'var': Math.pow(volInv * (1 - cashW), 2),
                            depositLimit: cons.depositLimit, taxRate: cons.taxLimit ? SIM_TAX_RATE : 0, taxLimit: cons.taxLimit || 0 });
      m.mc = mc;
      if (m.pension) {
        var unc = a.holdings.filter(function (h) { return h.unconfirmed; }).map(function (h) { return h.ticker; });
        if (m.pension.check) Object.assign(m.pension.check, { total: a.holdings.length, confirmed: a.holdings.length - unc.length, unconfirmed: unc });
        m.pension.tax = taxCredit(cons.taxLimit || 0, inp.monthly, mc);
      }
      var blocked = 0;   // 웹판은 주문 차단이 없으므로 '막힌 돈' 항목 없음
      m.cashPlan = cashPlan(t.key, a.cash, blocked, inp.monthly, data.deposits || null);
      if (m.compare) {
        m.compare['투자 비율'] = (a.invested / inp.capital * 100).toFixed(1) + '%';
        m.compare['종목 수'] = a.holdings.length + '개';
        m.compare['위험자산 (주식·리츠·원자재)'] = m.risky.toFixed(1) + '%';
        m.compare['몬테카를로 기대수익률 (연)'] = mc.expRet + '%';
        m.compare['목표 도달 확률'] = mc.success + '%';
      }
      return m;
  }
  function build(data, inp) {
    return { meta: buildMeta(data, inp), modes: data.modes.map(function (t) { return buildMode(data, t, inp); }) };
  }

  var api = { allocate: allocate, monteCarlo: monteCarlo, defaultTarget: defaultTarget, taxCredit: taxCredit,
              cashPlan: cashPlan, interest: interest, build: build, buildMeta: buildMeta, buildMode: buildMode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SIM = api;
})(this);
