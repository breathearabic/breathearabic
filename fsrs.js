/* FSRS-6 scheduler: a JavaScript port of py-fsrs 6.3.2 with its default parameters.
   States: 1 learning, 2 review, 3 relearning. Ratings: 1 again, 2 hard, 3 good, 4 easy.
   A card is {st, stp, s, d, due, last, r, l, f}: state, step, stability, difficulty,
   due time (ms), last review (ms), review count, lapse count, first review (ms). */
function makeScheduler(opts) {
  var W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
           1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
  var DECAY = -W[20], FACTOR = Math.pow(0.9, 1 / DECAY) - 1;
  var RET = opts.retention || 0.9, MAXI = 36500, MIN = 60000;
  var LEARN = [1 * MIN, 10 * MIN], RELEARN = [10 * MIN];
  var elapsed = opts.elapsed, reviewDue = opts.reviewDue, fuzzOn = !!opts.fuzz, rand = opts.random || Math.random;

  function pyRound(x) { var f = Math.floor(x), diff = x - f; if (diff > 0.5) return f + 1; if (diff < 0.5) return f; return f % 2 === 0 ? f : f + 1; }
  function clampD(d) { return Math.min(Math.max(d, 1), 10); }
  function clampS(s) { return Math.max(s, 0.001); }
  function initS(g) { return clampS(W[g - 1]); }
  function initD(g, clamp) { var d = W[4] - Math.exp(W[5] * (g - 1)) + 1; return clamp ? clampD(d) : d; }
  function nextIvl(s) {
    var i = (s / FACTOR) * (Math.pow(RET, 1 / DECAY) - 1);
    return Math.min(Math.max(pyRound(i), 1), MAXI);
  }
  function shortS(s, g) {
    var inc = Math.exp(W[17] * (g - 3 + W[18])) * Math.pow(s, -W[19]);
    if (g >= 2) inc = Math.max(inc, 1);
    return clampS(s * inc);
  }
  function nextD(d, g) {
    var a1 = initD(4, false), delta = -(W[6] * (g - 3));
    var a2 = d + (10 - d) * delta / 9;
    return clampD(W[7] * a1 + (1 - W[7]) * a2);
  }
  function forgetS(d, s, r) {
    var lt = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]);
    var st = s / Math.exp(W[17] * W[18]);
    return Math.min(lt, st);
  }
  function recallS(d, s, r, g) {
    var hp = g === 2 ? W[15] : 1, eb = g === 4 ? W[16] : 1;
    return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hp * eb);
  }
  function nextS(d, s, r, g) { return clampS(g === 1 ? forgetS(d, s, r) : recallS(d, s, r, g)); }
  function retr(c, now) {
    if (!c || c.last == null || c.s == null) return 0;
    var e = Math.max(0, elapsed(c.last, now));
    return Math.pow(1 + FACTOR * e / c.s, DECAY);
  }
  function fuzzDays(n) {
    if (n < 2.5) return n;
    var delta = 1;
    [[2.5, 7, 0.15], [7, 20, 0.1], [20, Infinity, 0.05]].forEach(function (r) {
      delta += r[2] * Math.max(Math.min(n, r[1]) - r[0], 0);
    });
    var mn = pyRound(n - delta), mx = pyRound(n + delta);
    mn = Math.max(2, mn); mx = Math.min(mx, MAXI); mn = Math.min(mn, mx);
    return Math.min(pyRound(rand() * (mx - mn + 1) + mn), MAXI);
  }
  function review(c0, g, now, noFuzz) {
    var c = c0
      ? {st: c0.st, stp: c0.stp, s: c0.s, d: c0.d, due: c0.due, last: c0.last, r: c0.r || 0, l: c0.l || 0, f: c0.f}
      : {st: 1, stp: 0, s: null, d: null, due: now, last: null, r: 0, l: 0, f: now};
    var days = c.last != null ? elapsed(c.last, now) : null;
    var stepMs = null, ivlDays = null, r;
    if (c.st === 1 || c.st === 3) {
      var steps = c.st === 1 ? LEARN : RELEARN;
      if (c.st === 1 && (c.s == null || c.d == null)) { c.s = initS(g); c.d = initD(g, true); }
      else if (days != null && days < 1) { c.s = shortS(c.s, g); c.d = nextD(c.d, g); }
      else { r = retr(c, now); c.s = nextS(c.d, c.s, r, g); c.d = nextD(c.d, g); }
      if (steps.length === 0 || (c.stp >= steps.length && g >= 2)) { c.st = 2; c.stp = null; ivlDays = nextIvl(c.s); }
      else if (g === 1) { c.stp = 0; stepMs = steps[0]; }
      else if (g === 2) {
        if (c.stp === 0 && steps.length === 1) stepMs = steps[0] * 1.5;
        else if (c.stp === 0 && steps.length >= 2) stepMs = (steps[0] + steps[1]) / 2;
        else stepMs = steps[c.stp];
      }
      else if (g === 3) {
        if (c.stp + 1 === steps.length) { c.st = 2; c.stp = null; ivlDays = nextIvl(c.s); }
        else { c.stp += 1; stepMs = steps[c.stp]; }
      }
      else { c.st = 2; c.stp = null; ivlDays = nextIvl(c.s); }
    } else {
      if (days != null && days < 1) c.s = shortS(c.s, g);
      else { r = retr(c, now); c.s = nextS(c.d, c.s, r, g); }
      c.d = nextD(c.d, g);
      if (g === 1) {
        c.l += 1;
        if (RELEARN.length === 0) ivlDays = nextIvl(c.s);
        else { c.st = 3; c.stp = 0; stepMs = RELEARN[0]; }
      } else ivlDays = nextIvl(c.s);
    }
    if (ivlDays != null && fuzzOn && !noFuzz && c.st === 2) ivlDays = fuzzDays(ivlDays);
    c.due = stepMs != null ? now + stepMs : reviewDue(now, ivlDays);
    c.last = now;
    c.r += 1;
    return c;
  }
  return {review: review, retrievability: retr, initS: initS, initD: initD, nextInterval: nextIvl, fuzzDays: fuzzDays};
}
if (typeof module !== "undefined") module.exports = makeScheduler;
