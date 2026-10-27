(function(){
"use strict";
var CFG = window.ARVOCAB_CONFIG || {};
var LV = ["", "A1", "A2", "B1", "B2", "C1", "C2"];
var TY = {n:"noun", v:"verb", a:"adjective", d:"adverb", p:"phrase", r:"particle"};
var CARDS = [], byId = new Map();
var $ = function(s){ return document.querySelector(s); };
var DAY = 86400000, MINUTE = 60000, ROLLOVER = 4;
var PAGE = 1000;

function esc(s){ return String(s).replace(/[&<>"']/g, function(ch){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]; }); }
function shuffle(a){ for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function norm(s){ return String(s).replace(/[ً-ْٰـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase(); }
function lsGet(k){ try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

// Where a visitor came from, for the admin page's "sign-ups by source". The bio links carry a tag (?yt, ?insta,
// ?tiktok, or ?from=yt); without one, the site they came from is used. The first one seen is kept until sign-up.
var SOURCE_NAMES = {yt:"youtube", youtube:"youtube", ig:"instagram", insta:"instagram", instagram:"instagram",
  tt:"tiktok", tiktok:"tiktok", fb:"facebook", facebook:"facebook"};
function tagSource(){
  var q = new URLSearchParams(location.search), tag = q.get("from");
  if (!tag) q.forEach(function(v, k){ if (!tag && v === "" && /^[a-z0-9_-]{1,30}$/i.test(k)) tag = k; });
  return tag ? SOURCE_NAMES[tag.toLowerCase()] || tag.toLowerCase() : "";
}
function referrerSource(){
  var h = ""; try { h = new URL(document.referrer).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
  if (!h || h === location.hostname) return "";
  if (/instagram\./.test(h)) return "instagram";
  if (/youtube\.|youtu\.be/.test(h)) return "youtube";
  if (/tiktok\./.test(h)) return "tiktok";
  if (/facebook\.|^fb\./.test(h)) return "facebook";
  if (/(^|\.)(google|bing|duckduckgo|yahoo|ecosia)\./.test(h)) return "search";
  return h.slice(0, 30);
}
(function(){
  var tag = tagSource(), seen = lsGet("arvocab-source");
  if (tag && (!seen || !seen.tag)) lsSet("arvocab-source", {src:tag, tag:true});   // a tag beats a guessed referrer
  else if (!seen) { var r = referrerSource(); if (r) lsSet("arvocab-source", {src:r}); }
})();
function sendSource(){
  var seen = lsGet("arvocab-source");
  if (!seen || seen.sent || !user) return;
  sb.rpc("set_signup_source", {src:seen.src}).then(function(r){
    if (!r.error) { seen.sent = true; lsSet("arvocab-source", seen); }
  });
}
function lsDel(k){ try { localStorage.removeItem(k); } catch (e) {} }

/* ---------- study days (a new day starts at 4am, like Anki) ---------- */
function dayStart(ms){ var d = new Date(ms); d.setHours(ROLLOVER, 0, 0, 0); if (d.getTime() > ms) d.setDate(d.getDate() - 1); return d.getTime(); }
function dayNum(ms){ var d = new Date(dayStart(ms)); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); }
function addDays(ms, n){ var d = new Date(dayStart(ms)); d.setDate(d.getDate() + n); return d.getTime(); }
var sched = makeScheduler({
  elapsed: function(last, now){ return dayNum(now) - dayNum(last); },
  reviewDue: function(now, days){ return addDays(now, days); },
  fuzz: true,
  // Anki's defaults: a new word comes back after 1 minute, then 10 minutes, then tomorrow; a forgotten one after 10 minutes.
  learnSteps: [1, 10],
  relearnSteps: [10]
});

/* ---------- stages, Anki-style ----------
   New → Learning (first steps, or just forgotten) → Young (memory lasts under KNOWN_DAYS) → Known → Mastered.
   "Memory" is FSRS stability: the days until the chance of remembering drops to 90%. */
var KNOWN_DAYS = +CFG.knownDays || 21, MASTERED_DAYS = 90;
var HARD_LAPSES = +CFG.hardWordLapses || 6;   // forgotten this many times after being learned = a hard word
function stageOf(s){
  if (!s) return "new";
  if (s.st === 1) return "learning";
  if (s.st === 3) return "relearning";
  return s.s >= MASTERED_DAYS ? "mastered" : s.s >= KNOWN_DAYS ? "known" : "young";
}
function isKnown(s){ return !!s && s.st === 2 && s.s >= KNOWN_DAYS; }
function isHard(s){ return !!s && (s.l || 0) >= HARD_LAPSES; }
var STAGE_LABEL = {"new":"New", learning:"Learning", relearning:"Relearning", young:"Young", known:"Known", mastered:"Mastered"};

/* ---------- Supabase ---------- */
var configured = !!(CFG.supabaseUrl && CFG.supabaseKey && window.supabase);
var sb = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true}
}) : null;
var user = null;          // {id, email}
var profile = null;       // {role, ...}
var member = null;        // row from memberships
var summary = [];         // [{level, total, free}] from deck_summary()
function ukey(k){ return "arvocab-u:" + user.id + ":" + k; }

/* ---------- preferences and progress ---------- */
var PREF_KEY = "arvocab-prefs-v1", LEGACY_PROG_KEY = "arvocab-progress-v1", LEGACY_SYNC_KEY = "arvocab-sync-url";
var prefs = Object.assign({deck:"main", levels:[1,2,3,4,5,6], mode:"cards", type:"all", dir:"ar", qlen:10, newPerDay:20, extra:null}, lsGet(PREF_KEY) || {});
prefs.levels = (prefs.levels || []).filter(function(l){ return l >= 1 && l <= 6; });
if (!prefs.levels.length || !prefs.allLevelsDefault) { prefs.levels = [1,2,3,4,5,6]; prefs.allLevelsDefault = true; lsSet(PREF_KEY, prefs); }
// The Islamic deck is chosen by category (the teacher's chapters) instead of by CEFR level.
var TOPICS = [
  {k:"aqeedah", ar:"الْعَقِيدَة", en:"Creed and sects"},
  {k:"usul", ar:"أُصُولُ الْفِقْه", en:"Principles of jurisprudence"},
  {k:"fiqh", ar:"الْفِقْه", en:"Jurisprudence and worship"},
  {k:"hadith", ar:"الْحَدِيثُ وَعُلُومُ الْقُرْآن", en:"Narrations and Quran sciences"},
  {k:"tazkiyah", ar:"التَّزْكِيَةُ وَالْأَخْلَاق", en:"Purifying the soul and character"},
  {k:"history", ar:"التَّارِيخُ وَالسِّيَاسَة", en:"History and governance"},
  {k:"thought", ar:"الْفِكْرُ الْمُعَاصِر", en:"Contemporary thought and society"}
];
var TOPIC_KEYS = TOPICS.map(function(t){ return t.k; });
prefs.topics = (prefs.topics || []).filter(function(k){ return TOPIC_KEYS.indexOf(k) > -1; });
if (!prefs.topics.length) prefs.topics = TOPIC_KEYS.slice();
function savePrefs(){ lsSet(PREF_KEY, prefs); }

function validState(s){
  return s && typeof s === "object" && (s.st === 1 || s.st === 2 || s.st === 3) && typeof s.s === "number" && s.s > 0 &&
    typeof s.d === "number" && typeof s.due === "number" && (s.last == null || typeof s.last === "number");
}
// Older versions stored 1 (still learning) or 2 (known); turn those into memory states.
function migrateValue(v, now){
  if (v === 2) return {st:2, stp:null, s:sched.initS(3), d:sched.initD(3, true), last:now, due:addDays(now, sched.nextInterval(sched.initS(3))), r:1, l:0, f:0};
  if (v === 1) return {st:1, stp:0, s:sched.initS(1), d:sched.initD(1, true), last:now, due:now, r:1, l:0, f:0};
  return validState(v) ? v : null;
}
function migrateMap(p){
  var out = {}, now = Date.now();
  Object.keys(p || {}).forEach(function(id){ if (byId.has(id)) { var s = migrateValue(p[id], now); if (s) out[id] = s; } });
  return out;
}
var prog = {p:{}};
function state(id){ return prog.p[id] || null; }

/* Changes not yet saved to the cloud. Kept on the device so nothing is lost offline.
   up: card id -> state to upsert, del: card id -> true, logs: answers for review_log, wipe: delete everything first. */
var outbox = {up:{}, del:{}, logs:[], wipe:false};
var outboxVer = 0, flushTimer = null, flushing = false, flushAgain = false, lastSaved = 0, saveError = false;
function outboxEmpty(){ return !outbox.wipe && !Object.keys(outbox.up).length && !Object.keys(outbox.del).length && !outbox.logs.length; }
function saveLocal(){ if (!user) return; lsSet(ukey("prog"), prog.p); lsSet(ukey("outbox"), outbox); }
function queueCard(id){
  if (prog.p[id]) { outbox.up[id] = prog.p[id]; delete outbox.del[id]; }
  else { delete outbox.up[id]; outbox.del[id] = true; }
}
function queueLog(id, g, at){ outbox.logs.push({card_id:id, rating:g, reviewed_at:new Date(at).toISOString()}); }
/* Answers per study day (day number -> count), for the streak and the 30-day chart on the home screen.
   Made from the review log on the server, plus answers saved here that haven't been sent yet. */
var activity = {};
function addActivity(logs){ logs.forEach(function(l){ var d = dayNum(Date.parse(l.reviewed_at)); activity[d] = (activity[d] || 0) + 1; }); }
function activityCounts(){
  var c = Object.assign({}, activity);
  outbox.logs.forEach(function(l){ var d = dayNum(Date.parse(l.reviewed_at)); c[d] = (c[d] || 0) + 1; });
  return c;
}
function fetchActivity(){
  var since = new Date(Date.now() - 40 * DAY).toISOString(), out = [];
  function page(from){
    return check(sb.from("review_log").select("reviewed_at").gte("reviewed_at", since).order("reviewed_at", {ascending:false}).range(from, from + PAGE - 1))
      .then(function(r){ out = out.concat(r.data || []); return r.data && r.data.length === PAGE && from < 9 * PAGE ? page(from + PAGE) : out; });
  }
  return page(0).catch(function(){ return null; });
}
function saveProgress(ids){
  (ids || []).forEach(queueCard);
  outboxVer++;
  saveLocal();
  renderStairs();
  scheduleFlush(1500);
}
function scheduleFlush(ms){ clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms); setSaveStatus(); }

function flush(){
  if (!user || !sb || outboxEmpty()) { setSaveStatus(); return Promise.resolve(); }
  if (!navigator.onLine) { setSaveStatus(); return Promise.resolve(); }
  if (flushing) { flushAgain = true; return Promise.resolve(); }
  flushing = true; setSaveStatus("saving");
  var snap = JSON.parse(JSON.stringify(outbox));
  var uid = user.id, nowIso = new Date().toISOString();
  var chain = Promise.resolve();
  if (snap.wipe) chain = chain.then(function(){ return check(sb.from("progress").delete().eq("user_id", uid)); });
  var delIds = Object.keys(snap.del);
  if (delIds.length) chain = chain.then(function(){ return check(sb.from("progress").delete().eq("user_id", uid).in("card_id", delIds)); });
  var rows = Object.keys(snap.up).map(function(id){
    var s = snap.up[id];
    return {user_id:uid, card_id:id, state:s, due:new Date(s.due).toISOString(), updated_at:nowIso};
  });
  for (var i = 0; i < rows.length; i += 500) (function(part){
    chain = chain.then(function(){ return check(sb.from("progress").upsert(part, {onConflict:"user_id,card_id"})); });
  })(rows.slice(i, i + 500));
  if (snap.logs.length) chain = chain.then(function(){
    return check(sb.from("review_log").insert(snap.logs.map(function(l){ return {user_id:uid, card_id:l.card_id, rating:l.rating, reviewed_at:l.reviewed_at}; })));
  });
  return chain.then(function(){
    // Remove what was sent, unless it changed again while we were sending.
    delIds.forEach(function(id){ if (outbox.del[id]) delete outbox.del[id]; });
    Object.keys(snap.up).forEach(function(id){ if (JSON.stringify(outbox.up[id]) === JSON.stringify(snap.up[id])) delete outbox.up[id]; });
    // Sent answers now count from the server's log, so keep them in the day counts.
    addActivity(outbox.logs.slice(0, snap.logs.length)); lsSet(ukey("activity"), activity);
    outbox.logs.splice(0, snap.logs.length);
    // A reset made while this was sending sets a newer wipe stamp; keep that one.
    if (snap.wipe && outbox.wipe === snap.wipe) outbox.wipe = false;
    saveLocal();
    saveError = false; lastSaved = Date.now();
  }).catch(function(err){
    saveError = true;
    console.warn("Saving progress failed", err);
    if (isAuthError(err)) { setSaveStatus("auth"); return; }
    clearTimeout(flushTimer); flushTimer = setTimeout(flush, 30000);
  }).then(function(){
    flushing = false;
    if (flushAgain) { flushAgain = false; flush(); }
    setSaveStatus();
  });
}
function check(q){ return q.then(function(r){ if (r.error) throw r.error; return r; }); }
function isAuthError(e){ return e && (e.code === "PGRST301" || e.status === 401 || /JWT/i.test(e.message || "")); }

/* ---------- loading from the cloud ---------- */
// Example sentences (especially ones saved from the Read page) can carry a stray comma, dash or space; tidy them for display.
function tidySentence(s){
  var ref = (String(s || "").match(/\s*\(\d+:\d+\)$/) || [""])[0];
  var t = String(s || "").slice(0, String(s || "").length - ref.length).replace(/\s+/g, " ").trim()
    .replace(/\s+([،,.;:!?؟)])/g, "$1").replace(/\(\s+/g, "(")
    .replace(/^[،,.;:\-–—]\s*/, "").replace(/\s*[،,;:\-–—]$/, "");
  return ref ? t + " " + ref.trim() : t;
}
function toCard(r){ return {id:r.id, deck:r.deck || "main", ar:r.arabic, en:r.english, lv:r.level, ty:r.word_type, ex:Array.isArray(r.examples) ? r.examples.map(function(e){ return [tidySentence(e[0]).replace(/[.۔]+$/, ""), tidySentence(e[1])]; }) : [], so:r.sort_order, free:r.is_free, tp:r.topic || ""}; }
function setCards(list){
  // Words saved on the Read page have ids starting "u-".
  list.forEach(function(c){ c.mine = /^u-/.test(c.id); });
  CARDS = list.slice().sort(function(a, b){ return a.so - b.so; });
  byId = new Map(CARDS.map(function(c){ return [c.id, c]; }));
}
function fetchAll(table, cols, order){
  var out = [];
  function page(from){
    var q = sb.from(table).select(cols).order(order, {ascending:true}).range(from, from + PAGE - 1);
    return check(q).then(function(r){
      out = out.concat(r.data || []);
      return r.data && r.data.length === PAGE ? page(from + PAGE) : out;
    });
  }
  return page(0);
}
function loadRemote(){
  var uid = user.id;
  return Promise.all([
    fetchAll("cards", "id,deck,topic,level,word_type,arabic,english,examples,sort_order,is_free,is_active", "sort_order"),
    fetchAll("progress", "card_id,state", "card_id"),
    check(sb.from("memberships").select("*").eq("user_id", uid).maybeSingle()),
    check(sb.from("profiles").select("id,email,display_name,role").eq("id", uid).maybeSingle()),
    check(sb.rpc("deck_summary")),
    fetchActivity()
  ]).then(function(res){
    if (!user || user.id !== uid) return;
    if (res[5]) { activity = {}; addActivity(res[5]); lsSet(ukey("activity"), activity); }
    setCards(res[0].filter(function(c){ return c.is_active !== false; }).map(toCard));   // editors can also see retired words
    var p = {};
    res[1].forEach(function(r){ if (byId.has(r.card_id) && validState(r.state)) p[r.card_id] = r.state; });
    // Answers still waiting to be sent win over what the server has.
    if (outbox.wipe) p = {};
    Object.keys(outbox.del).forEach(function(id){ delete p[id]; });
    Object.keys(outbox.up).forEach(function(id){ p[id] = outbox.up[id]; });
    prog.p = p;
    serverProgressCount = res[1].length;
    member = res[2].data || null;
    profile = res[3].data || null;
    sendSource();
    summary = (res[4].data || []).map(function(s){ return {deck:s.deck || "main", level:+s.level, total:+s.total, free:+s.free}; });
    lsSet(ukey("cards"), CARDS);
    lsSet(ukey("member"), member);
    lsSet(ukey("profile"), profile);
    lsSet(ukey("summary"), summary);
    lsSet(ukey("loadedAt"), Date.now());
    saveLocal();
    loadedOnline = true;
  });
}
var serverProgressCount = -1, loadedOnline = false, lastPull = 0;
function loadCached(){
  var cards = lsGet(ukey("cards"));
  if (!cards || !cards.length) return false;
  setCards(cards);
  member = lsGet(ukey("member"));
  profile = lsGet(ukey("profile"));
  summary = lsGet(ukey("summary")) || [];
  activity = lsGet(ukey("activity")) || {};
  outbox = Object.assign({up:{}, del:{}, logs:[], wipe:false}, lsGet(ukey("outbox")) || {});
  var p = lsGet(ukey("prog")) || {};
  prog.p = {};
  Object.keys(p).forEach(function(id){ if (byId.has(id) && validState(p[id])) prog.p[id] = p[id]; });
  return true;
}
function refresh(){
  if (!user || !navigator.onLine) return Promise.resolve();
  lastPull = Date.now();
  loadRemind();
  return loadRemote().then(function(){
    if (!fc.revealed) fc.cur = null;
    renderAll();
    flush();
    maybeOfferImport();
  }).catch(function(err){
    console.warn("Loading from the cloud failed", err);
    if (isAuthError(err)) setSaveStatus("auth");
    else if (!CARDS.length) showLoadError();
  });
}

/* ---------- membership and locked levels ---------- */
// Admins and editors can fix deck cards: an Edit link opens the card in the admin page's Flashcards editor.
function canEditCards(c){ return !!profile && (profile.role === "admin" || profile.role === "editor") && !!c && !c.mine && !/^u-/.test(c.id); }
function editCardLink(c, cls){ return canEditCards(c) ? '<a class="' + cls + '" href="admin.html#card=' + encodeURIComponent(c.id) + '">Edit card</a>' : ""; }
function hasAccess(){
  var m = member;
  if (profile && (profile.role === "admin" || profile.role === "editor")) return true;   // editors can read the whole deck anyway
  if (!m) return false;
  var end = m.current_period_end ? Date.parse(m.current_period_end) : null, now = Date.now();
  if ((m.status === "active" || m.status === "comp") && (end == null || end > now)) return true;
  if ((m.status === "canceled" || m.status === "past_due") && end != null && end > now) return true;
  return false;
}
// Deck counts leave out the learner's own saved words (from the Read page).
// Two decks: the main vocabulary and the Islamic terms. Everything below works on the chosen one.
var DECKS = {main:{name:"General Vocabulary", sub:"Everyday Arabic to strengthen your comprehension and fluency"}, islamic:{name:"Islamic terms", sub:"Key terms for reading Islamic books: creed, jurisprudence, hadith, history and modern ideas"}};
function inDeck(c){ return (c.deck || "main") === prefs.deck; }
function deckVisible(lv){ return CARDS.filter(function(c){ return c.lv === lv && !c.mine && inDeck(c); }).length; }
function mineCount(lv){ return CARDS.filter(function(c){ return c.lv === lv && c.mine && inDeck(c); }).length; }
function deckSize(d){ var n = summary.filter(function(x){ return (x.deck || "main") === d; }).reduce(function(a, x){ return a + x.total; }, 0); return n || CARDS.filter(function(c){ return (c.deck || "main") === d && !c.mine; }).length; }
function levelTotal(lv){
  var s = summary.filter(function(x){ return x.level === lv && (x.deck || "main") === prefs.deck; })[0];
  return Math.max(s ? s.total : 0, deckVisible(lv));
}
// A level is locked when the deck has words there that this account can't see.
// "Words" filter: all words, only saved words (Read page), or only hard words.
function sourceOk(c){ return prefs.source === "mine" ? c.mine : prefs.source === "hard" ? isHard(state(c.id)) : true; }
function filtered(){ return prefs.source === "mine" || prefs.source === "hard"; }
function isLocked(lv){ return !filtered() && levelTotal(lv) > deckVisible(lv); }
function lockedSelected(){ return byTopic() ? [] : prefs.levels.filter(isLocked).sort(); }   // the Islamic deck is all free
function lockedWordCount(levels){ return levels.reduce(function(n, lv){ return n + levelTotal(lv) - deckVisible(lv); }, 0); }

/* ---------- queues ---------- */
function typeOk(c){
  if (prefs.type === "all") return true;
  if (prefs.type === "other") return c.ty === "d" || c.ty === "r";
  return c.ty === prefs.type;
}
function byTopic(){ return prefs.deck === "islamic"; }
// A learner's own saved words have no category, so they count in every category.
function topicOk(c){ return !c.tp || TOPIC_KEYS.indexOf(c.tp) < 0 || prefs.topics.indexOf(c.tp) > -1; }
function pool(){ return CARDS.filter(function(c){ return inDeck(c) && (byTopic() ? topicOk(c) : prefs.levels.indexOf(c.lv) > -1) && typeOk(c) && sourceOk(c); }); }
function levelNames(){ return prefs.levels.slice().sort().map(function(l){ return LV[l]; }); }
function levelLabel(cap){
  if (byTopic()) {
    var n = prefs.topics.length;
    if (n >= TOPICS.length) return cap ? "All categories" : "all categories";
    return n > 2 ? n + " of " + TOPICS.length + " categories" : joinNames(TOPICS.filter(function(t){ return prefs.topics.indexOf(t.k) > -1; }).map(function(t){ return t.en; }));
  }
  return prefs.levels.length >= 6 ? (cap ? "All levels" : "all levels") : joinNames(levelNames());
}
function joinNames(a){ return a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
// Each deck has its own new-words-a-day limit and its own count, e.g. 20 general words and 5 Quran words.
function deckNewPerDay(){
  var m = prefs.newPerDayByDeck || {};
  return m[prefs.deck] != null ? m[prefs.deck] : prefs.deck === "main" ? (prefs.newPerDay || 20) : 10;
}
// Today's work left in the deck you're not studying: reviews due plus new words still allowed.
function otherDeckWork(now){
  var mine = prefs.deck, other = Object.keys(DECKS).filter(function(d){ return d !== mine; })[0];
  if (!other) return null;
  prefs.deck = other;
  try {
    var q = queueInfo(now), due = q.learnDue.length + q.revDue.length, fresh = q.newShown;
  } finally { prefs.deck = mine; }
  if (!due && !fresh) return null;
  var parts = [];
  if (due) parts.push(due + " to review");
  if (fresh) parts.push(fresh + " new");
  return {deck:other, label:parts.join(", ")};
}
function newStartedToday(now){
  var start = dayStart(now), n = 0;
  for (var id in prog.p) {
    var c = byId.get(id);
    if (prog.p[id].f && prog.p[id].f >= start && c && inDeck(c)) n++;
  }
  return n;
}
function newLimitToday(now){
  var e = prefs.extra, extra = e && e.day === dayNum(now) && (e.deck || "main") === prefs.deck ? e.n : 0;
  return deckNewPerDay() + extra;
}
/* A word still being learned that was last answered earlier today, before this visit to the site, waits until
   tomorrow: once someone leaves, the day's study is over and words don't reappear when they open the site again.
   While the site stays open, learning words come back as usual. */
var VISIT_START = Date.now();
function heldTillTomorrow(s, now){ return s.st !== 2 && s.last != null && s.last >= dayStart(now) && s.last < VISIT_START; }
function queueInfo(now){
  var p = pool(), learnDue = [], learnLater = [], revDue = [], fresh = [], learned = 0, learning = 0, held = 0;
  p.forEach(function(c){
    var s = state(c.id);
    if (!s) { fresh.push(c); return; }
    if (s.st === 2) { if (isKnown(s)) learned++; if (s.due <= now) revDue.push(c); }
    else if (heldTillTomorrow(s, now)) { learning++; held++; }
    else { learning++; if (s.due <= now) learnDue.push(c); else learnLater.push(c); }
  });
  var byDue = function(a, b){ return state(a.id).due - state(b.id).due; };
  learnDue.sort(byDue); learnLater.sort(byDue); revDue.sort(byDue);
  // New words come level by level (all A1 first, then A2, ...), in deck order within a level.
  // Words already studied are untouched: they follow their own memory schedule.
  fresh.sort(function(a, b){ return (a.lv - b.lv) || (a.so - b.so); });
  var newLeft = Math.max(0, newLimitToday(now) - newStartedToday(now));
  return {pool:p, learnDue:learnDue, learnLater:learnLater, revDue:revDue, fresh:fresh, newShown:Math.min(newLeft, fresh.length), newLeft:newLeft, learned:learned, learning:learning, held:held};
}
/* Spacing: a word you've just answered sits out until SPACING other cards have been shown (or RECENT_MS
   has passed), so you never see the same word back-to-back.
   Once nothing else is left, every learning word due before the next study day (4am) is shown straight away,
   so a day's study is finished in one sitting and nobody has to come back an hour later. */
var SPACING = 5, RECENT_MS = 10 * MINUTE, LEARN_AHEAD = 20 * MINUTE;
function recentIds(now){ return fc.recent.filter(function(r){ return now - r.at < RECENT_MS; }).slice(-SPACING).map(function(r){ return r.id; }); }
function pickNext(now){
  var q = queueInfo(now), recent = recentIds(now);
  var fresh = function(c){ return recent.indexOf(c.id) < 0; };
  var due = q.learnDue.concat(q.revDue).sort(function(a, b){ return state(a.id).due - state(b.id).due; });
  var news = q.newShown ? q.fresh.slice(0, q.newShown) : [];
  var dayEnd = dayStart(now) + DAY;
  var ahead = q.learnLater.filter(function(c){ return state(c.id).due < dayEnd; });
  var pick = due.filter(fresh)[0] || news.filter(fresh)[0] || ahead.filter(fresh)[0];
  if (pick) return pick.id;
  // Only words seen a few cards ago are left: show the one seen longest ago, to keep repeats far apart.
  var left = due.length ? due : ahead;
  if (!left.length) return null;
  var lastSeen = function(c){ var r = fc.recent.filter(function(x){ return x.id === c.id; }).pop(); return r ? r.at : 0; };
  return left.slice().sort(function(a, b){ return lastSeen(a) - lastSeen(b); })[0].id;
}
// When the next learning word becomes due.
function nextAvailableAt(now){
  var q = queueInfo(now);
  if (!q.learnLater.length) return Infinity;
  var due = state(q.learnLater[0].id).due;
  return due < dayStart(now) + DAY ? now : due;
}

/* ---------- staircase ---------- */
var stairs = $("#stairs");
for (var l = 1; l <= 6; l++) {
  var b = document.createElement("button");
  b.type = "button"; b.className = "step lv" + l; b.dataset.lv = l; b.style.setProperty("--i", l - 1);
  b.innerHTML = '<span class="fill"></span><span class="lv">' + LV[l] + '</span><span class="ct"></span>';
  stairs.appendChild(b);
}
stairs.addEventListener("click", function(e){
  var b = e.target.closest(".step"); if (!b || b.disabled) return;
  var lv = +b.dataset.lv, i = prefs.levels.indexOf(lv);
  if (i > -1) { if (prefs.levels.length > 1) prefs.levels.splice(i, 1); }
  else prefs.levels.push(lv);
  savePrefs(); onFilterChange();
});
$("#allBtn").addEventListener("click", function(){
  prefs.levels = [1,2,3,4,5,6].filter(function(l){ return levelTotal(l) > 0; });
  savePrefs(); onFilterChange();
});
// Categories for the Islamic deck, in place of the level staircase.
$("#topics").addEventListener("click", function(e){
  var b = e.target.closest(".topic"); if (!b || b.disabled) return;
  var i = prefs.topics.indexOf(b.dataset.topic);
  if (i > -1) { if (prefs.topics.length > 1) prefs.topics.splice(i, 1); }
  else prefs.topics.push(b.dataset.topic);
  savePrefs(); onFilterChange();
});
$("#allTopicsBtn").addEventListener("click", function(){ prefs.topics = TOPIC_KEYS.slice(); savePrefs(); onFilterChange(); });
function renderTopics(){
  $("#topics").innerHTML = TOPICS.map(function(t){
    var cs = CARDS.filter(function(c){ return inDeck(c) && c.tp === t.k && sourceOk(c); });
    var learned = cs.filter(function(c){ return isKnown(state(c.id)); }).length;
    return '<button type="button" class="topic" data-topic="' + t.k + '" aria-pressed="' + (prefs.topics.indexOf(t.k) > -1) + '"' + (cs.length ? "" : " disabled") + '>' +
      '<span class="t-ar" lang="ar">' + esc(t.ar) + '</span><span class="t-en">' + esc(t.en) + '</span><span class="t-ct">' + learned + '/' + cs.length + ' known</span></button>';
  }).join("");
  var q = queueInfo(Date.now()), due = q.learnDue.length + q.revDue.length;
  $("#topicSummary").textContent = levelLabel(true) + ": " + q.pool.length + " words. " + q.learned + " known, " + due + " due, " + q.fresh.length + " new.";
}
function renderStairs(){
  $("#levelPicker").hidden = byTopic(); $("#topicPicker").hidden = !byTopic();
  if (byTopic()) { renderTopics(); $("#lockBanner").hidden = true; return; }
  var steps = stairs.querySelectorAll(".step");
  for (var k = 0; k < steps.length; k++) {
    var b = steps[k], lv = +b.dataset.lv;
    var cs = CARDS.filter(function(c){ return c.lv === lv && sourceOk(c); });
    var total = filtered() ? cs.length : levelTotal(lv) + mineCount(lv), locked = isLocked(lv);
    var learned = cs.filter(function(c){ return isKnown(state(c.id)); }).length;
    var pct = total ? Math.round(learned / total * 100) : 0;
    b.style.setProperty("--fill", pct + "%");
    b.classList.toggle("locked", locked);
    b.querySelector(".ct").textContent = locked ? "Members" : learned + "/" + total;
    b.setAttribute("aria-pressed", prefs.levels.indexOf(lv) > -1 ? "true" : "false");
    b.setAttribute("aria-label", LV[lv] + ": " + total + " words, " + (locked ? "members only" : learned + " known"));
    b.disabled = !total && !filtered();
  }
  var q = queueInfo(Date.now());
  var due = q.learnDue.length + q.revDue.length;
  $("#levelSummary").textContent = levelLabel(true) + ": " + q.pool.length + " words. " + q.learned + " known, " + due + " due, " + q.fresh.length + " new.";
  renderLockBanner();
}
function renderLockBanner(){
  var el = $("#lockBanner"), locked = lockedSelected();
  var open = prefs.levels.filter(function(lv){ return !isLocked(lv); });
  // Only locked levels chosen: the panel itself shows the members-only note instead.
  if (!locked.length || !open.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '<span>' + esc(joinNames(locked.map(function(l){ return LV[l]; }))) + ' ' + (locked.length === 1 ? "is" : "are") + ' for members (' + lockedWordCount(locked) + ' more words).</span>' +
    '<button class="btn primary" data-act="subscribe" type="button">Subscribe</button>';
}
function membersOnlyHtml(){
  var locked = lockedSelected();
  return '<div class="panel-msg members"><h2>Members only</h2><p>' + esc(joinNames(locked.map(function(l){ return LV[l]; }))) + ' ' + (locked.length === 1 ? "has " : "have ") + lockedWordCount(locked) +
    ' words for members. A1 and A2 are free for everyone with an account.</p>' +
    '<div class="actions single"><button class="btn primary" data-act="subscribe" type="button">Subscribe' + (CFG.priceLabel ? " · " + esc(CFG.priceLabel) : "") + '</button></div></div>';
}
function onlyLockedChosen(){ var locked = lockedSelected(); return locked.length && locked.length === prefs.levels.length; }

/* ---------- mode and filters ---------- */
var tabs = document.querySelectorAll(".tab");
for (var t = 0; t < tabs.length; t++) tabs[t].addEventListener("click", function(){ setMode(this.dataset.mode); });
function setMode(m){
  prefs.mode = m; savePrefs();
  // Keep the address in step (e.g. #study/quiz) so Back and bookmarks work.
  if (view === "study" && location.hash !== "#study/" + m) history.replaceState(null, "", "#study/" + m);
  for (var i = 0; i < tabs.length; i++) tabs[i].setAttribute("aria-selected", tabs[i].dataset.mode === m ? "true" : "false");
  $("#panel-cards").hidden = m !== "cards";
  $("#panel-quiz").hidden = m !== "quiz";
  $("#panel-list").hidden = m !== "list";
  $("#dirWrap").hidden = m === "list";
  $("#newWrap").hidden = m !== "cards";
  if (m === "cards") renderCard();
  if (m === "quiz" && !qz.qs) renderQuizStart();
  if (m === "list") renderList();
}
var typeSel = $("#typeSel"), dirSel = $("#dirSel"), newSel = $("#newSel");
typeSel.value = prefs.type; dirSel.value = prefs.dir; newSel.value = String(deckNewPerDay());
typeSel.addEventListener("change", function(){ prefs.type = this.value; savePrefs(); onFilterChange(); });
dirSel.addEventListener("change", function(){ prefs.dir = this.value; savePrefs(); if (prefs.mode === "cards") renderCard(); if (qz.qs && qz.i < qz.qs.length) renderQuestion(); });
newSel.addEventListener("change", function(){ prefs.newPerDayByDeck = Object.assign({}, prefs.newPerDayByDeck); prefs.newPerDayByDeck[prefs.deck] = +this.value; savePrefs(); fc.cur = null; renderStairs(); renderCard(); });
var srcSel = $("#srcSel");
srcSel.value = prefs.source === "mine" || prefs.source === "hard" ? prefs.source : "all";
srcSel.addEventListener("change", function(){ prefs.source = this.value; savePrefs(); onFilterChange(); });
function onFilterChange(){
  renderStairs();
  fc.cur = null; fc.revealed = false;
  qz.qs = null;
  if (prefs.mode === "cards") renderCard();
  if (prefs.mode === "quiz") renderQuizStart();
  if (prefs.mode === "list") renderList();
}

/* ---------- speech ---------- */
// Natural Arabic audio (see speech.js), with the device's own voice as a fallback.
var speaker = window.makeSpeaker({client:function(){ return sb; }, baseUrl:CFG.supabaseUrl, voice:CFG.ttsVoice, rate:CFG.ttsRate, enabled:CFG.tts !== false && configured, onError:function(m){ toast(m); }});
document.body.classList.toggle("can-speak", speaker.available());
function speak(text){ speaker.speak(text); }

/* ---------- formatting ---------- */
function arSizeClass(s){ return s.length > 34 ? " xlong" : s.length > 18 ? " long" : ""; }
function exHtml(c, cls){
  if (!c.ex.length) return "";
  return '<div class="' + (cls || "examples") + '">' + c.ex.map(function(e){
    return '<div class="ex"><p class="ex-ar" lang="ar">' + esc(e[0]) + '</p><p class="ex-en">' + esc(e[1]) + '</p></div>';
  }).join("") + '</div>';
}
var STAGE_CLASS = {"new":"", learning:"s1", relearning:"s3", young:"sy", known:"s2", mastered:"s2"};
function stageTag(id){
  var s = state(id), st = stageOf(s);
  return (isHard(s) ? '<span class="st hard">Hard word</span>' : "") + '<span class="st ' + STAGE_CLASS[st] + '">' + STAGE_LABEL[st] + '</span>';
}
function ivlLabel(next, now){
  if (next.st !== 2) { var m = Math.max(1, Math.round((next.due - now) / MINUTE)); return m < 60 ? m + "m" : Math.round(m / 60) + "h"; }
  var d = dayNum(next.due) - dayNum(now);
  if (d < 30) return d + "d";
  if (d < 365) return (Math.round(d / 30 * 10) / 10).toString() + "mo";
  return (Math.round(d / 365 * 10) / 10).toString() + "y";
}
function whenLabel(ms, now){
  var d = dayNum(ms) - dayNum(now);
  if (ms <= now) return "now";
  if (d <= 0) return "at " + new Date(ms).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
  if (d === 1) return "tomorrow";
  if (d < 30) return "in " + d + " days";
  return "on " + new Date(ms).toLocaleDateString([], {day:"numeric", month:"short", year: d > 300 ? "numeric" : undefined});
}
function memDays(st){ var v = st < 10 ? Math.round(st * 10) / 10 : Math.round(st); return v + (v === 1 ? " day" : " days"); }
// Rounded for display: "4 days", "3 weeks", "2 months".
function spanLabel(days){
  if (days < 1) return "under a day";
  if (days < 14) { var d = Math.round(days); return d + (d === 1 ? " day" : " days"); }
  if (days < 60) return Math.round(days / 7) + " weeks";
  if (days < 365) return Math.round(days / 30) + " months";
  var y = Math.round(days / 365 * 10) / 10; return y + (y === 1 ? " year" : " years");
}
// Memory strength as a bar: a log scale from 1 day to 4 months, with a mark where a word counts as known.
function memFrac(days){ return Math.max(0.03, Math.min(1, Math.log(Math.max(1, days)) / Math.log(120))); }
function memBarHtml(s){
  return '<div class="membar"><div class="membar-top"><span>Memory</span><span>' + spanLabel(s.s) + '</span></div>' +
    '<div class="membar-track" role="img" aria-label="Memory lasts about ' + memDays(s.s) + '; a word is known at ' + KNOWN_DAYS + ' days">' +
    '<i style="width:' + (memFrac(s.s) * 100).toFixed(1) + '%"></i><b style="left:' + (memFrac(KNOWN_DAYS) * 100).toFixed(1) + '%"></b></div></div>';
}
// The moment a word first counts as known: a short message over the next card, since the card itself moves on.
function celebrateKnown(card, s, now){
  var el = document.createElement("div");
  el.className = "known-pop"; el.setAttribute("role", "status");
  // Same interval the "I remember" button showed ("1.5mo" → "1.5 months").
  var when = ivlLabel(s, now).replace(/^(\d+(?:\.\d+)?)(mo|d|y|h|m)$/, function(_, n, u){
    var name = {mo:"month", d:"day", y:"year", h:"hour", m:"minute"}[u]; return n + " " + name + (n === "1" ? "" : "s");
  });
  el.innerHTML = '<span class="kp-tick" aria-hidden="true">✓</span><span><b lang="ar">' + esc(card.ar) + '</b> is now known</span><small>Next review in ' + when + '</small>';
  document.body.appendChild(el);
  if (navigator.vibrate) try { navigator.vibrate(12); } catch (e) {}
  setTimeout(function(){ el.remove(); }, 2600);
}
function memoryLine(id, now){
  var s = state(id);
  if (!s) return "Not studied yet.";
  var r = Math.round(sched.retrievability(s, now) * 100);
  var parts = [];
  parts.push(s.st === 2 ? (s.due <= now ? "Due for review now." : "Next review " + whenLabel(s.due, now) + ".") : heldTillTomorrow(s, now) ? "Still in its learning steps; comes back tomorrow." : (s.due <= now ? "Still in its learning steps and due now." : "Still in its learning steps; comes back " + whenLabel(s.due, now) + "."));
  parts.push("Memory lasts about " + memDays(s.s) + " before recall drops to 90%.");
  var st = stageOf(s);
  if (st === "young") parts.push("It counts as known once its memory reaches " + KNOWN_DAYS + " days.");
  else if (st === "known" || st === "mastered") parts.push(st === "mastered" ? "Mastered: memory lasts " + MASTERED_DAYS + "+ days." : "Known: memory lasts " + KNOWN_DAYS + "+ days.");
  if (s.st === 2) parts.push("Chance you'd remember it right now: " + r + "%.");
  parts.push("Reviewed " + s.r + " time" + (s.r === 1 ? "" : "s") + (s.l ? ", forgotten " + s.l + " time" + (s.l === 1 ? "" : "s") : "") + ".");
  if (isHard(s)) parts.push("A hard word: forgotten " + s.l + " times after learning it. Try the example sentence or saying it aloud.");
  return parts.join(" ");
}
function dateLabel(iso){ return new Date(iso).toLocaleDateString([], {day:"numeric", month:"long", year:"numeric"}); }

/* ---------- importing progress from the single-user app ---------- */
var importState = null; // null, or {local:{p,t,n}, sheetUrl, msg, busy}
function legacyLocal(){
  var saved = lsGet(LEGACY_PROG_KEY);
  if (!saved || !saved.p) return null;
  var p = migrateMap(saved.p), n = Object.keys(p).length;
  // Words from levels this account can't open yet can't be saved to it.
  var locked = Object.keys(saved.p).filter(function(id){ return !byId.has(id) && saved.p[id]; }).length;
  return n ? {p:p, t:saved.t || 0, n:n, locked:locked} : null;
}
function wordsLabel(n){ return n + (n === 1 ? " word" : " words"); }
function maybeOfferImport(){
  if (!user || importState || lsGet(ukey("import-done"))) return;
  if (serverProgressCount !== 0 || !outboxEmpty() || Object.keys(prog.p).length) return;
  var local = legacyLocal(), url = lsGet(LEGACY_SYNC_KEY) || "";
  if (!local && !url) return;
  importState = {local:local, sheetUrl:url, msg:"", busy:false};
  if (view === "home") renderHome(); else if (prefs.mode === "cards") renderCard();
}
function openImport(){
  importState = {local:legacyLocal(), sheetUrl:lsGet(LEGACY_SYNC_KEY) || "", msg:"", busy:false, manual:true};
  setMode("cards");
  window.scrollTo({top:$("#panel-cards").offsetTop - 20, behavior:"smooth"});
}
function importHtml(){
  var s = importState, local = s.local;
  var html = '<div class="panel-msg import"><h2>Bring your progress with you</h2>';
  html += '<p>Your account starts empty. If you used the earlier version of this app, you can copy what you studied there into your account. This replaces anything already in your account.</p>';
  html += '<div class="import-opts">';
  if (local) html += '<button class="btn primary" data-act="import-local" type="button"' + (s.busy ? " disabled" : "") + '>Import ' + wordsLabel(local.n) + ' from this device</button>' +
    (local.locked ? '<p class="msg">' + wordsLabel(local.locked) + ' from members-only levels will be left out. Subscribe first if you want to bring those too.</p>' : "");
  html += '<div class="import-sheet"><label for="importUrl">Or import from your Google Sheet (App Progress tab). Paste your sync link:</label>' +
    '<input id="importUrl" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://script.google.com/macros/s/.../exec" value="' + esc(s.sheetUrl || "") + '">' +
    '<button class="btn" data-act="import-sheet" type="button"' + (s.busy ? " disabled" : "") + '>Import from Google Sheet</button></div>';
  html += '</div>';
  if (s.msg) html += '<p class="msg" aria-live="polite">' + esc(s.msg) + '</p>';
  html += '<p><button class="link" data-act="import-skip" type="button">' + (s.manual ? "Cancel" : "Start fresh instead") + '</button></p></div>';
  return html;
}
// Same format the Google Sheet script returns: {header, rows} with the FSRS state as JSON in the Data column.
function parseSheet(d){
  var h = (d.header || []).map(String), rows = d.rows || [];
  var iCard = h.indexOf("Card"), iData = h.indexOf("Data"), iStatus = h.indexOf("Status");
  var p = {};
  if (iCard > -1 && iData > -1) {
    rows.forEach(function(r){
      var id = String(r[iCard]).trim();
      if (!byId.has(id)) return;
      try { var s = JSON.parse(r[iData]); if (validState(s)) p[id] = s; } catch (e) {}
    });
  } else if (iCard > -1 && iStatus > -1) {
    var old = {};
    rows.forEach(function(r){ var st = String(r[iStatus]).trim(); old[String(r[iCard]).trim()] = st === "Known" ? 2 : st === "Still learning" ? 1 : 0; });
    p = migrateMap(old);
  } else if (d.progress) p = migrateMap(d.progress);
  return p;
}
function applyImport(p, from){
  var n = Object.keys(p).length;
  if (!n) { importState.msg = "There was no progress to import " + from + "."; importState.busy = false; renderCard(); return; }
  prog.p = p;
  outbox.wipe = Date.now(); outbox.up = {}; outbox.del = {};
  Object.keys(p).forEach(function(id){ outbox.up[id] = p[id]; });
  lsSet(ukey("import-done"), true);
  importState = null;
  fc.cur = null; fc.undo = null;
  saveProgress([]);
  flush();
  renderAll();
  toast("Imported " + wordsLabel(n) + " " + from + ".");
}
$("#panel-cards").addEventListener("click", function(e){
  var a = e.target.closest("[data-act]"); if (!a || !importState) return;
  var act = a.dataset.act;
  if (act === "import-local") { var loc = legacyLocal(); applyImport(loc ? loc.p : {}, "from this device"); }
  else if (act === "import-skip") { if (!importState.manual) lsSet(ukey("import-done"), true); importState = null; renderCard(); }
  else if (act === "import-sheet") {
    var u = ($("#importUrl").value || "").trim().split("?")[0].split("#")[0];
    importState.sheetUrl = u;
    if (!/^https:\/\/script\.google\.com\/(a\/[^\/]+\/)?macros\/s\/[\w-]+\/exec$/.test(u)) { importState.msg = "That doesn't look like a sync link. It starts with https://script.google.com/macros/s/ and ends with /exec."; renderCard(); return; }
    importState.busy = true; importState.msg = "Reading your Google Sheet…"; renderCard();
    fetch(u, {method:"GET", cache:"no-store"}).then(function(r){ return r.json(); }).then(function(d){
      if (!d || !d.ok) throw new Error("bad response");
      applyImport(parseSheet(d), "from your Google Sheet");
    }).catch(function(){
      if (!importState) return;
      importState.busy = false; importState.msg = "Couldn't read your Google Sheet with that link. Check you're online and the link is the Web app URL from Apps Script.";
      renderCard();
    });
  }
}, true);

/* ---------- flashcards ---------- */
var fc = {cur:null, revealed:false, recent:[], undo:null, timer:null};
function renderCard(){
  var el = $("#panel-cards"), now = Date.now();
  clearTimeout(fc.timer);
  if (importState) { el.innerHTML = importHtml(); return; }
  if (fc.cur && !byId.has(fc.cur)) fc.cur = null;
  if (!fc.cur) { fc.cur = pickNext(now); fc.revealed = false; }
  var q = queueInfo(now);
  var countsHtml = '<span class="counts"><span class="cn"><b>' + q.newShown + '</b> new</span><span class="cl"><b>' + (q.learnDue.length + q.learnLater.length) + '</b> learning</span><span class="cr"><b>' + q.revDue.length + '</b> to review</span></span>';
  var undoHtml = fc.undo ? '<button class="link" data-act="undo" type="button">Undo</button>' : "";
  if (!fc.cur) {
    var html = '<div class="meta">' + countsHtml + '<span class="meta-right">' + undoHtml + '</span></div>';
    if (onlyLockedChosen()) { el.innerHTML = html + membersOnlyHtml(); return; }
    if (!q.pool.length) {
      el.innerHTML = html + (prefs.source === "mine" && !CARDS.some(function(c){ return c.mine; })
        ? '<div class="panel-msg"><h2>No saved words yet</h2><p>On the Read page, tap a word you don\'t know and choose Save word. It will show up here.</p><div class="actions single"><a class="btn primary" href="read">Open Read</a></div></div>'
        : '<div class="panel-msg"><h2>No words match</h2><p>Try another word type or add a ' + (byTopic() ? "category" : "level") + ' above.</p></div>');
      return;
    }
    var lines = [];
    var nextLearn = q.learnLater[0];
    if (nextLearn) lines.push("A word you're learning comes back " + whenLabel(state(nextLearn.id).due, now) + ". Leave the app open or come back then.");
    var futureRev = q.pool.filter(function(c){ var s = state(c.id); return s && s.st === 2 && s.due > now; })
      .sort(function(a, b){ return state(a.id).due - state(b.id).due; });
    if (futureRev.length) {
      var firstDay = dayNum(state(futureRev[0].id).due);
      var sameDay = futureRev.filter(function(c){ return dayNum(state(c.id).due) === firstDay; }).length;
      lines.push("Next reviews: " + sameDay + " word" + (sameDay === 1 ? "" : "s") + " " + whenLabel(state(futureRev[0].id).due, now) + ".");
    }
    var moreBtn = "";
    if (q.fresh.length && q.newLeft === 0) {
      lines.push("You've started " + newStartedToday(now) + " new words today, which is your daily limit. More arrive tomorrow.");
      moreBtn = '<button class="btn" data-act="more-new" type="button">Learn ' + Math.min(10, q.fresh.length) + ' more new words today</button>';
    } else if (!q.fresh.length) {
      lines.push(lockedSelected().length ? "You've started every free word you've chosen. Members can keep going with " + joinNames(lockedSelected().map(function(l){ return LV[l]; })) + "." : "You've started every word in " + levelLabel() + ". Add another level above to keep going.");
    }
    // If the other deck still has work today, offer that first instead of a quiz.
    var other = otherDeckWork(now), goBtn = other
      ? '<button class="btn primary" data-act="go-deck" data-deck="' + other.deck + '" type="button">Continue with ' + esc(DECKS[other.deck].name) + ' (' + other.label + ')</button>'
      : '<button class="btn primary" data-act="to-quiz" type="button">Quiz yourself instead</button>';
    if (other) moreBtn = moreBtn || '<button class="btn" data-act="to-quiz" type="button">Quiz instead</button>';
    el.innerHTML = html + '<div class="panel-msg"><h2>' + (other ? "This deck is done for today" : "All caught up") + '</h2><p>' +
      (other ? esc(DECKS[other.deck].name) + ' still has ' + other.label + ' for today.' : 'Nothing else is due in ' + levelLabel() + ' right now.') + '</p>' +
      '<div class="done-list">' + lines.map(function(x){ return '<p>' + esc(x) + '</p>'; }).join("") + '</div>' +
      '<div class="actions' + (moreBtn ? "" : " single") + '">' + moreBtn + goBtn + '</div></div>';
    if (nextLearn) {
      var wait = nextAvailableAt(now) - now;
      if (wait < 6 * 3600000) fc.timer = setTimeout(function(){ if (prefs.mode === "cards") renderCard(); }, Math.max(wait, 1000) + 500);
    }
    return;
  }
  var c = byId.get(fc.cur), s = state(c.id), arFirst = prefs.dir === "ar";
  var html2 = '<div class="meta">' + countsHtml + '<span class="meta-right">' + undoHtml + '</span></div>';
  html2 += '<div class="card' + (fc.flip ? " flip" : "") + '" id="card" tabindex="0" role="button" aria-label="' + (fc.revealed ? "Card" : "Show answer") + '">';
  fc.flip = false;
  html2 += '<div class="card-top"><span class="pill lv' + c.lv + '">' + LV[c.lv] + '</span><span class="tytag">' + TY[c.ty] + '</span>' + stageTag(c.id) + editCardLink(c, "edit-card") + '<button class="listen" data-act="speak" type="button" aria-label="Listen to the Arabic">Listen</button></div>';
  html2 += arFirst
    ? '<div class="prompt is-ar' + arSizeClass(c.ar) + '" lang="ar">' + esc(c.ar) + '</div>'
    : '<div class="prompt is-en">' + esc(c.en) + '</div>';
  // Arabic first: the example sentences show on the front too, so the flip only reveals the English.
  if (arFirst && c.ex.length) html2 += '<div class="front-ex">' + c.ex.map(function(e){ return '<p class="ex-ar" lang="ar">' + esc(e[0]) + '</p>'; }).join("") + '</div>';
  if (fc.revealed) {
    html2 += '<div class="answer" aria-live="polite">' + (arFirst
      ? '<div class="answer-main is-en">' + esc(c.en) + '</div>' +
        (c.ex.length ? '<div class="examples">' + c.ex.map(function(e){ return '<p class="ex-en">' + esc(e[1]) + '</p>'; }).join("") + '</div>' : "")
      : '<div class="answer-main is-ar" lang="ar">' + esc(c.ar) + '</div>' + exHtml(c)) +
      (s ? memBarHtml(s) : '<p class="mem">First time seeing this word.</p>') + '</div>';
  } else {
    html2 += '<div class="tap">Try to recall it, then tap to check</div>';
  }
  html2 += '</div>';
  if (fc.revealed) {
    var choices = [{g:1, key:"1", label:"I don't remember", cls:"again"}, {g:3, key:"2", label:"I remember", cls:"good"}];
    html2 += '<div class="grade two" role="group" aria-label="Did you remember it?">';
    choices.forEach(function(ch){
      var nx = sched.review(s, ch.g, now, true);
      html2 += '<button class="gbtn ' + ch.cls + '" data-grade="' + ch.g + '" type="button">' + ch.label + '<small>next in ' + ivlLabel(nx, now) + '</small><kbd>' + ch.key + '</kbd></button>';
    });
    html2 += '</div><p class="hint">Press 1 if you didn\'t remember it, 2 or Space if you did.</p>';
  } else {
    html2 += '<div class="actions single"><button class="btn primary" data-act="reveal" type="button">Show answer<kbd>Space</kbd></button></div>';
    html2 += '<p class="hint">Space shows the answer.</p>';
  }
  el.innerHTML = html2;
}
function reveal(){ if (!fc.cur || fc.revealed) return; fc.revealed = true; fc.flip = true; renderCard(); }
function rate(g){
  if (!fc.cur || !fc.revealed) return;
  var id = fc.cur, now = Date.now(), wasKnown = isKnown(state(id));
  fc.undo = {id:id, prev:state(id), extra:prefs.extra ? Object.assign({}, prefs.extra) : null, logs:outbox.logs.length};
  prog.p[id] = sched.review(state(id), g, now);
  queueLog(id, g, now);
  fc.recent.push({id:id, at:now}); if (fc.recent.length > 20) fc.recent.shift();
  fc.cur = null; fc.revealed = false;
  saveProgress([id]);
  renderCard();
  if (!wasKnown && isKnown(prog.p[id])) celebrateKnown(byId.get(id), prog.p[id], now);
}
function undo(){
  if (!fc.undo) return;
  var u = fc.undo;
  if (u.prev) prog.p[u.id] = u.prev; else delete prog.p[u.id];
  // Drop the answer from the log too, if it hasn't been sent yet.
  if (outbox.logs.length === u.logs + 1 && outbox.logs[u.logs].card_id === u.id) outbox.logs.pop();
  fc.undo = null; fc.cur = u.id; fc.revealed = true;
  if (fc.recent.length && fc.recent[fc.recent.length - 1].id === u.id) fc.recent.pop();
  saveProgress([u.id]);
  renderCard();
}
$("#panel-cards").addEventListener("click", function(e){
  if (importState) return;
  var gb = e.target.closest("[data-grade]");
  if (gb) return rate(+gb.dataset.grade);
  var a = e.target.closest("[data-act]");
  if (a) {
    var act = a.dataset.act;
    if (act === "speak") { e.stopPropagation(); var c = byId.get(fc.cur); if (c) speak(c.ar); return; }
    if (act === "reveal") return reveal();
    if (act === "undo") return undo();
    if (act === "to-quiz") return setMode("quiz");
    if (act === "go-deck") { setDeck(e.target.closest("[data-act]").dataset.deck); $("#deckName").textContent = DECKS[prefs.deck].name; renderStairs(); return renderCard(); }
    if (act === "more-new") {
      var day = dayNum(Date.now());
      var same = prefs.extra && prefs.extra.day === day && (prefs.extra.deck || "main") === prefs.deck;
      prefs.extra = {day:day, deck:prefs.deck, n:(same ? prefs.extra.n : 0) + 10};
      savePrefs(); fc.cur = null; renderStairs(); return renderCard();
    }
    if (act === "subscribe") return;
  }
  if (e.target.closest("#card")) reveal();
});

/* ---------- quiz ---------- */
var qz = {qs:null, i:0, score:0, misses:[], answered:false, picked:null};
function senseKey(en){ return en.split(/[,(\/;×]/)[0].trim().toLowerCase().replace(/^to /, ""); }
function makeOptions(c, p){
  var src = p.length >= 8 ? p : CARDS;
  var same = shuffle(src.filter(function(x){ return x.ty === c.ty && x.id !== c.id; }));
  var other = shuffle(src.filter(function(x){ return x.ty !== c.ty && x.id !== c.id; }));
  var keys = {}, ars = {}; keys[senseKey(c.en)] = 1; ars[norm(c.ar)] = 1;
  var opts = [c], cand = same.concat(other);
  for (var i = 0; i < cand.length && opts.length < 4; i++) {
    var x = cand[i], k = senseKey(x.en), a = norm(x.ar);
    if (keys[k] || ars[a]) continue;
    keys[k] = 1; ars[a] = 1; opts.push(x);
  }
  return shuffle(opts).map(function(x){ return x.id; });
}
function renderQuizStart(){
  var p = pool(), el = $("#panel-quiz");
  if (onlyLockedChosen()) { el.innerHTML = membersOnlyHtml(); return; }
  if (p.length < 2) {
    el.innerHTML = '<div class="panel-msg"><h2>Not enough words for a quiz</h2><p>Add another ' + (byTopic() ? "category" : "level") + ' or switch the word type back to All types.</p></div>';
    return;
  }
  var lens = [10, 20, 40].filter(function(n){ return n < p.length; });
  if (p.length <= 60) lens.push(p.length);
  if (lens.indexOf(prefs.qlen) < 0) prefs.qlen = lens[0];
  el.innerHTML = '<div class="panel-msg"><h2>Quiz on ' + levelLabel() + '</h2><p>' + p.length + ' words to draw from. Words you miss are marked Again, so they come straight back in your reviews. Right answers leave your review schedule as it is.</p>' +
    '<div class="lengths" role="group" aria-label="Number of questions">' + lens.map(function(n){
      return '<button type="button" data-len="' + n + '" aria-pressed="' + (n === prefs.qlen) + '">' + (n === p.length && n > 40 ? "All " + n : n + " questions") + '</button>';
    }).join("") + '</div>' +
    '<div class="actions single"><button class="btn primary" data-act="start" type="button">Start quiz</button></div></div>';
}
function startQuiz(ids){
  var p = pool();
  var picks = ids ? ids.map(function(id){ return byId.get(id); }) : shuffle(p.slice()).slice(0, Math.min(prefs.qlen, p.length));
  qz.qs = picks.map(function(c){ return {id:c.id, opts:makeOptions(c, p)}; });
  qz.i = 0; qz.score = 0; qz.misses = []; qz.answered = false; qz.picked = null;
  renderQuestion();
}
function renderQuestion(){
  var el = $("#panel-quiz");
  if (qz.i >= qz.qs.length) return renderResults();
  var q = qz.qs[qz.i], c = byId.get(q.id), arFirst = prefs.dir === "ar";
  if (!c) { qz.qs = null; return renderQuizStart(); }
  var html = '<div class="meta"><span>Question ' + (qz.i + 1) + ' of ' + qz.qs.length + '</span><span>' + qz.score + ' correct</span></div>';
  html += '<div class="qprompt"><div class="card-top"><span class="pill lv' + c.lv + '">' + LV[c.lv] + '</span><span class="tytag">' + TY[c.ty] + '</span><button class="listen" data-act="speak" type="button" aria-label="Listen to the Arabic" style="margin-left:auto">Listen</button></div>';
  html += arFirst ? '<div class="prompt is-ar' + arSizeClass(c.ar) + '" lang="ar">' + esc(c.ar) + '</div>' : '<div class="prompt is-en">' + esc(c.en) + '</div>';
  html += '</div><div class="opts" role="group" aria-label="Answers">';
  q.opts.forEach(function(id, k){
    var o = byId.get(id), cls = "opt";
    if (!o) return;
    if (qz.answered) { if (id === q.id) cls += " correct"; else if (id === qz.picked) cls += " wrong"; }
    html += '<button class="' + cls + '" data-opt="' + id + '" type="button"' + (qz.answered ? " disabled" : "") + '><span class="k">' + (k + 1) + '</span>' +
      (arFirst ? '<span class="t">' + esc(o.en) + '</span>' : '<span class="t ar" lang="ar">' + esc(o.ar) + '</span>') + '</button>';
  });
  html += '</div>';
  if (qz.answered) {
    var right = qz.picked === q.id;
    html += '<div class="feedback" aria-live="polite"><strong>' + (right ? "Correct." : "Not quite.") + '</strong> <span lang="ar" class="ar">' + esc(c.ar) + '</span> means ' + esc(c.en) + '.' +
      (c.ex.length ? '<p class="ex-ar" lang="ar">' + esc(c.ex[0][0]) + '</p><p class="ex-en">' + esc(c.ex[0][1]) + '</p>' : "") + '</div>';
    html += '<div class="actions single"><button class="btn primary" data-act="next" type="button">' + (qz.i + 1 < qz.qs.length ? "Next question" : "See results") + '<kbd>Enter</kbd></button></div>';
  }
  el.innerHTML = html;
}
function answer(id){
  if (qz.answered) return;
  var q = qz.qs[qz.i];
  qz.answered = true; qz.picked = id;
  if (id === q.id) qz.score++;
  else {
    var now = Date.now();
    qz.misses.push(q.id);
    prog.p[q.id] = sched.review(state(q.id), 1, now);
    queueLog(q.id, 1, now);
    fc.cur = null; fc.undo = null;
    saveProgress([q.id]);
  }
  renderQuestion();
}
function renderResults(){
  var el = $("#panel-quiz"), n = qz.qs.length;
  var html = '<div class="panel-msg"><p>Your score</p><div class="big-score">' + qz.score + ' / ' + n + '</div>';
  if (qz.misses.length) {
    html += '<p>These are now back in your reviews:</p><div class="misses">' + qz.misses.map(function(id){
      var c = byId.get(id);
      return c ? '<div class="miss"><span>' + esc(c.en) + '</span><span class="ar" lang="ar">' + esc(c.ar) + '</span></div>' : "";
    }).join("") + '</div>';
    html += '<div class="actions"><button class="btn primary" data-act="study-misses" type="button">Practise them in Review</button><button class="btn" data-act="new" type="button">New quiz</button></div>';
  } else {
    html += '<p>No misses this time.</p><div class="actions single"><button class="btn primary" data-act="new" type="button">New quiz</button></div>';
  }
  el.innerHTML = html + '</div>';
}
$("#panel-quiz").addEventListener("click", function(e){
  var len = e.target.closest("[data-len]");
  if (len) { prefs.qlen = +len.dataset.len; savePrefs(); return renderQuizStart(); }
  var o = e.target.closest("[data-opt]");
  if (o) return answer(o.dataset.opt);
  var a = e.target.closest("[data-act]"); if (!a) return;
  var act = a.dataset.act;
  if (act === "start") return startQuiz();
  if (act === "speak") { var c = byId.get(qz.qs[qz.i].id); return speak(c.ar); }
  if (act === "next") { qz.i++; qz.answered = false; qz.picked = null; return renderQuestion(); }
  if (act === "study-misses") { fc.cur = null; return setMode("cards"); }
  if (act === "new") { qz.qs = null; return renderQuizStart(); }
});

/* ---------- word list ---------- */
var openRows = {};
function renderList(){
  var q = norm($("#search").value.trim()), now = Date.now();
  var cards = pool().filter(function(c){ return !q || norm(c.ar).indexOf(q) > -1 || c.en.toLowerCase().indexOf(q) > -1; });
  var el = $("#list");
  var lockedLv = lockedSelected();
  if (!cards.length && !lockedLv.length) { el.innerHTML = '<div class="panel-msg"><h2>No matches</h2><p>' + (q ? "Nothing in " + levelLabel() + " matches that search. Try fewer letters or add a " + (byTopic() ? "category" : "level") + "." : "Try another word type or add a level above.") + '</p></div>'; return; }
  var html = "";
  // Groups: CEFR levels, or the teacher's categories in the Islamic deck.
  var groups = byTopic()
    ? TOPICS.map(function(t){ return {head:esc(t.en) + ' · <span lang="ar" style="font-family:var(--ar)">' + esc(t.ar) + '</span>', cls:"", of:function(c){ return c.tp === t.k; }}; })
        .concat([{head:"Your saved words", cls:"", of:function(c){ return TOPIC_KEYS.indexOf(c.tp) < 0; }}])
    : [1,2,3,4,5,6].map(function(lv){ return {lv:lv, head:LV[lv], cls:" lv" + lv, of:function(c){ return c.lv === lv; }}; });
  groups.forEach(function(g){
    var lv = g.lv, group = cards.filter(g.of);
    if (lockedLv.indexOf(lv) > -1 && !group.length) {
      html += '<h3 class="lvhead lv' + lv + '">' + LV[lv] + ' <span>' + levelTotal(lv) + ' words</span></h3>' +
        '<div class="row locked-row"><p>Members only. <button class="link" data-act="subscribe" type="button">Subscribe</button> to study these words.</p></div>';
      return;
    }
    if (!group.length) return;
    group.sort(function(a, b){ return a.en.localeCompare(b.en); });
    html += '<h3 class="lvhead' + g.cls + '">' + g.head + ' <span>' + group.length + ' word' + (group.length === 1 ? "" : "s") + '</span></h3>';
    group.forEach(function(c){
      var s = state(c.id), st = stageOf(s), cls = STAGE_CLASS[st] || "s0";
      var label = STAGE_LABEL[st];
      var sub = st === "new" ? "new" : label.toLowerCase() + (s.st === 2 ? ", " + (s.due <= now ? "due now" : "next review " + whenLabel(s.due, now)) : "") + (isHard(s) ? ", hard word" : "");
      html += '<div class="row" data-id="' + c.id + '"><div class="row-main">' +
        '<span class="dot ' + cls + '" role="img" aria-label="' + label + '"></span>' +
        '<button class="row-en" data-act="open" type="button" aria-expanded="' + (!!openRows[c.id]) + '">' + esc(c.en) + '<small>' + TY[c.ty] + ', ' + sub + (c.mine ? ' · <span class="mine-tag">saved</span>' : "") + '</small></button>' +
        '<div class="row-ar" lang="ar">' + esc(c.ar) + '</div></div>';
      if (openRows[c.id]) {
        html += '<div class="row-ex">' + (c.ex.length ? exHtml(c, "") : '<p class="ex-en">No example sentence for this one yet.</p>') +
          '<p class="mem">' + esc(memoryLine(c.id, now)) + '</p>' + editCardLink(c, "link") +
          (s ? '<button class="btn" data-act="forget" type="button">Reset this word to new</button>' : "") +
          (c.mine ? '<div class="mine-tools"><label>Level <select data-act="relevel">' + [1,2,3,4,5,6].map(function(l){ return '<option value="' + l + '"' + (l === c.lv ? " selected" : "") + '>' + LV[l] + '</option>'; }).join("") + '</select></label>' +
            '<button class="link danger" data-act="unsave" type="button">Remove from my saved words</button></div>' : "") + '</div>';
      }
      html += '</div>';
    });
  });
  el.innerHTML = html;
}
var searchTimer = null;
$("#search").addEventListener("input", function(){ clearTimeout(searchTimer); searchTimer = setTimeout(renderList, 120); });
$("#list").addEventListener("click", function(e){
  var a = e.target.closest("[data-act]"); if (!a) return;
  if (a.dataset.act === "subscribe") return;
  var id = a.closest(".row").dataset.id;
  if (a.dataset.act === "relevel") return;
  if (a.dataset.act === "open") openRows[id] = !openRows[id];
  else if (a.dataset.act === "forget") { delete prog.p[id]; fc.cur = null; fc.undo = null; saveProgress([id]); }
  else if (a.dataset.act === "unsave") return unsave(id, a);
  renderList();
});
$("#list").addEventListener("change", function(e){
  if (e.target.dataset.act !== "relevel") return;
  var id = e.target.closest(".row").dataset.id, c = byId.get(id), lv = +e.target.value;
  if (!c || !navigator.onLine) { toast("You need to be online to change a level."); return renderList(); }
  check(sb.from("cards").update({level:lv, updated_at:new Date().toISOString()}).eq("id", id)).then(function(){
    c.lv = lv; lsSet(ukey("cards"), CARDS); renderStairs(); renderList();
  }).catch(function(){ toast("Couldn't change the level. Please try again."); renderList(); });
});
// Saved words (from the Read page) can be deleted; their progress goes with them.
function unsave(id, btn){
  if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = "Tap again to remove it"; return; }
  if (!navigator.onLine) { toast("You need to be online to remove a word."); return; }
  check(sb.from("cards").delete().eq("id", id)).then(function(){
    delete prog.p[id]; delete outbox.up[id]; delete outbox.del[id];
    setCards(CARDS.filter(function(c){ return c.id !== id; }));
    lsSet(ukey("cards"), CARDS); saveLocal();
    fc.cur = null; fc.undo = null; renderAll();
  }).catch(function(){ toast("Couldn't remove it. Please try again."); });
}

/* ---------- keyboard ---------- */
document.addEventListener("keydown", function(e){
  if (!user || view !== "study") return;
  var tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea" || e.metaKey || e.ctrlKey || e.altKey) return;
  var onButton = tag === "button";
  var go = e.key === " " || e.key === "Enter";
  if (prefs.mode === "cards" && fc.cur && !importState) {
    if (!fc.revealed && go && !onButton) { e.preventDefault(); reveal(); }
    else if (fc.revealed && e.key === "1") { e.preventDefault(); rate(1); }
    else if (fc.revealed && (e.key === "2" || (go && !onButton))) { e.preventDefault(); rate(3); }
  } else if (prefs.mode === "quiz" && qz.qs && qz.i < qz.qs.length) {
    var q = qz.qs[qz.i];
    if (!qz.answered && /^[1-4]$/.test(e.key) && q.opts[+e.key - 1]) { e.preventDefault(); answer(q.opts[+e.key - 1]); }
    else if (qz.answered && e.key === "Enter" && !onButton) { e.preventDefault(); qz.i++; qz.answered = false; qz.picked = null; renderQuestion(); }
  }
});

/* ---------- reset ---------- */
var resetArmed = null;
$("#resetBtn").addEventListener("click", function(){
  var b = this;
  if (!resetArmed) {
    b.textContent = "Tap again to clear all progress";
    resetArmed = setTimeout(function(){ resetArmed = null; b.textContent = "Reset all my progress"; }, 4000);
    return;
  }
  clearTimeout(resetArmed); resetArmed = null; b.textContent = "Reset all my progress";
  prog.p = {}; outbox.wipe = Date.now(); outbox.up = {}; outbox.del = {};
  fc.cur = null; fc.undo = null; saveProgress([]); renderAll();
});

/* ---------- subscribe and manage subscription ---------- */
function invoke(name, body){
  return sb.functions.invoke(name, {body:body}).then(function(r){
    if (r.error) throw r.error;
    if (!r.data || !r.data.url) throw new Error((r.data && r.data.error) || "no url");
    return r.data.url;
  });
}
function appUrl(extra){ return location.origin + location.pathname + (extra || ""); }
function subscribe(btn){
  if (!CFG.paymentsEnabled) { toast("Subscriptions are opening soon."); return; }
  if (!navigator.onLine) { toast("You're offline. Connect to the internet to subscribe."); return; }
  if (btn) btn.disabled = true;
  toast("Opening checkout…");
  invoke("create-checkout", {success_url:appUrl("?checkout=success"), return_url:appUrl()}).then(function(url){
    location.href = url;
  }).catch(function(err){
    console.warn(err);
    toast("Couldn't open checkout. Please try again in a minute.");
    if (btn) btn.disabled = false;
  });
}
function manage(btn){
  if (!navigator.onLine) { toast("You're offline. Connect to the internet to manage your subscription."); return; }
  if (btn) btn.disabled = true;
  invoke("customer-portal", {return_url:appUrl()}).then(function(url){ location.href = url; }).catch(function(err){
    console.warn(err);
    toast("Couldn't open your subscription page. Please try again in a minute.");
    if (btn) btn.disabled = false;
  });
}
document.addEventListener("click", function(e){
  var a = e.target.closest("[data-act]"); if (!a) return;
  if (a.dataset.act === "subscribe") { e.preventDefault(); subscribe(a); }
  else if (a.dataset.act === "manage") { e.preventDefault(); manage(a); }
  else if (a.dataset.act === "import-open") { e.preventDefault(); openImport(); }
  else if (a.dataset.act === "practise-hard") {
    // Show only hard words (the Words filter on the study screen switches back).
    prefs.source = "hard"; savePrefs(); $("#srcSel").value = "hard"; $("#srcWrap").hidden = false;
    qz.qs = null; fc.cur = null; location.hash = "#study/" + a.dataset.to;
  }
});
// Back from a successful checkout: the payment webhook usually lands within seconds.
function waitForMembership(){
  var tries = 0;
  toast("Payment received. Unlocking your levels…", 20000);
  (function poll(){
    tries++;
    check(sb.from("memberships").select("*").eq("user_id", user.id).maybeSingle()).then(function(r){
      member = r.data || member;
      if (hasAccess()) { toast("Welcome! Every level is unlocked."); return refresh(); }
      if (tries < 20) setTimeout(poll, 2000);
      else toast("Your payment went through, but unlocking is taking longer than usual. Reload the page in a minute.", 15000);
    }).catch(function(){ if (tries < 20) setTimeout(poll, 3000); });
  })();
}

/* ---------- account box ---------- */
function memberLine(){
  var m = member;
  if (profile && profile.role === "admin") return "Admin: you can see every level.";
  if (!m || !hasAccess()) {
    if (m && (m.status === "canceled" || m.status === "past_due")) return "Your membership has ended. A1 and A2 are still free.";
    return "Free account: A1 and A2 are open. Subscribe to unlock B1 to C2.";
  }
  var end = m.current_period_end;
  if (m.status === "comp") return end ? "Gifted membership until " + dateLabel(end) + "." : "Gifted lifetime membership.";
  if (m.status === "canceled" || m.cancel_at_period_end) return "Member until " + dateLabel(end) + ". Your subscription won't renew.";
  if (m.status === "past_due") return "Member. Your last payment didn't go through; please update your card before " + dateLabel(end) + ".";
  return "Member" + (end ? ", renews on " + dateLabel(end) : "") + ".";
}
function renderAccount(){
  if (!user) return;
  $("#acctEmail").textContent = user.email || "";
  $("#acctPlan").textContent = memberLine();
  var paid = member && member.provider && (member.status === "active" || member.status === "past_due" || member.status === "canceled");
  var isAdmin = profile && profile.role === "admin";
  var btns = "";
  if (!hasAccess()) btns += '<button class="btn primary" data-act="subscribe" type="button">Subscribe' + (CFG.priceLabel ? " · " + esc(CFG.priceLabel) : "") + '</button>';
  if (paid) btns += '<button class="btn" data-act="manage" type="button">Manage or cancel subscription</button>';
  if (isAdmin) btns += '<a class="btn" href="admin">Admin</a>';
  $("#acctBtns").innerHTML = btns;
  setSaveStatus();
}
/* ---------- daily reminder email ---------- */
// remind: null until loaded (the row stays hidden), then {on, tz}.
var remind = null, remindBusy = false;
function deviceTz(){ try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London"; } catch (e) { return "Europe/London"; } }
function loadRemind(){
  var uid = user.id;
  // Asked for on its own, so the rest of the app still loads if 005_reminders.sql hasn't been run yet.
  sb.from("profiles").select("remind,remind_tz").eq("id", uid).maybeSingle().then(function(r){
    if (!user || user.id !== uid) return;
    if (r.error || !r.data) { remind = null; renderRemind(); return; }
    remind = {on:!!r.data.remind, tz:r.data.remind_tz};
    renderRemind();
    // Moved to another time zone: keep the reminder arriving in the evening there.
    if (remind.on && remind.tz !== deviceTz()) saveRemind(true, true);
  });
}
function renderRemind(){
  var row = $("#remindRow"); if (!row) return;
  row.hidden = !user || !remind;
  if (remind) $("#remindBox").checked = remind.on;
  $("#remindBox").disabled = remindBusy;
}
function saveRemind(on, quiet){
  var uid = user.id, tz = deviceTz();
  remindBusy = true; renderRemind();
  check(sb.from("profiles").update({remind:on, remind_tz:tz}).eq("id", uid)).then(function(){
    if (user && user.id === uid) remind = {on:on, tz:tz};
    if (!quiet) toast(on ? "Daily reminders on. We'll only email on days you have words due and haven't studied." : "Daily reminders off.");
  }).catch(function(err){
    console.warn("Saving the reminder setting failed", err);
    if (!quiet) toast(navigator.onLine ? "Couldn't save that. Please try again." : "You're offline. Try again when you're back online.");
  }).then(function(){ remindBusy = false; renderRemind(); });
}
$("#remindBox").addEventListener("change", function(){
  if (!user || !remind || remindBusy) return;
  saveRemind(this.checked);
});
// The "Stop these reminders" link in each email works signed in or out: its token is the proof.
(function(){
  var m = /[?&]unsubscribe=([0-9a-f-]{36})(?:&|$)/i.exec(location.search);
  if (!m || !configured) return;
  history.replaceState(null, "", location.pathname + location.hash);
  sb.rpc("reminder_unsubscribe", {t:m[1]}).then(function(r){
    if (r.error) { toast("Couldn't switch reminders off. Please try the link again, or untick it in your account box.", 9000); return; }
    if (remind) { remind.on = false; renderRemind(); }
    toast(r.data ? "Daily reminder emails are off. You can switch them back on in your account box." : "That link has already been used or is out of date. You can switch reminders off in your account box.", 9000);
  });
})();

function setSaveStatus(st){
  var el = $("#saveStatus"); if (!el || !user) return;
  var msg, cls = "";
  if (st === "auth") { msg = "You've been signed out on this device. Sign in again to keep saving; your answers are kept here until then."; cls = "bad"; }
  else if (!navigator.onLine) msg = outboxEmpty() ? "You're offline. Answers will be saved here and sent to your account when you're back online." : "You're offline. Your latest answers are saved on this device and will sync when you're back online.";
  else if (st === "saving" || flushing) msg = "Saving…";
  else if (saveError) { msg = "Couldn't reach the server. Your answers are safe on this device and will be sent again automatically."; cls = "bad"; }
  else if (!outboxEmpty()) msg = "Saving shortly…";
  else { msg = "All progress saved to your account" + (lastSaved ? " at " + new Date(lastSaved).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) : "") + "."; cls = "on"; }
  el.textContent = msg; el.className = cls;
}
$("#signOutBtn").addEventListener("click", function(){
  var b = this;
  if (!outboxEmpty() && !navigator.onLine && !b.dataset.armed) {
    b.dataset.armed = "1"; b.textContent = "Some answers aren't synced yet. Tap again to sign out anyway";
    setTimeout(function(){ delete b.dataset.armed; b.textContent = "Sign out"; }, 5000);
    return;
  }
  flush().then(function(){
    var uid = user && user.id;
    return sb.auth.signOut({scope:"local"}).catch(function(){}).then(function(){ if (uid) clearUserCache(uid); });
  });
});
function clearUserCache(uid){
  var pre = "arvocab-u:" + uid + ":", keys = [];
  try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(pre) === 0 && !/:outbox$|:import-done$/.test(k)) keys.push(k); } } catch (e) {}
  keys.forEach(lsDel);
}

/* ---------- small messages ---------- */
var toastTimer = null;
function toast(msg, ms){
  var el = $("#toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(function(){ el.hidden = true; }, ms || 5000);
}
function showLoadError(){
  $("#panel-cards").innerHTML = '<div class="panel-msg"><h2>Couldn\'t load your words</h2><p>Check your internet connection, then reload the page. Once loaded, the app also works offline.</p></div>';
}

/* ---------- sign in ---------- */
var signin = {email:"", sent:false, busy:false, msg:"", bad:false};
function showSignedOut(){
  user = null; profile = null; member = null; CARDS = []; byId = new Map(); prog.p = {}; importState = null; remind = null; renderRemind();
  $("#appMain").hidden = true; $("#landing").hidden = false; $("#topSub").hidden = true; $("#topnav").hidden = true;
  if (window.BA_TABS) BA_TABS.hide();
  // The landing page only mentions the Read page once it's open to everyone.
  var reader = CFG.readerAccess === "everyone";
  document.querySelectorAll("#landing [data-reader]").forEach(function(el){ el.hidden = !reader; });
  var after = document.querySelector("#landing [data-num-after-reader]"); if (after) after.textContent = reader ? "4" : "3";
  if (CFG.priceLabel) $("#planPrice").textContent = CFG.priceLabel;
  // Show the free plan in the same currency as the price (e.g. "$0" next to "$5 a month").
  var sym = /^[^\d\s]/.exec(CFG.priceLabel || ""); if (sym) $("#freePrice").textContent = sym[0] + "0";
  renderSignin();
}
// Landing page buttons scroll to the sign-in box (or the explanation) instead of changing the address.
$("#landing").addEventListener("click", function(e){
  var a = e.target.closest('a[href^="#"]'); if (!a) return;
  e.preventDefault();
  var target = a.getAttribute("href") === "#how" ? $("#how") : $("#signin");
  target.scrollIntoView({behavior:"smooth", block:"start"});
  if (target.id === "signin") setTimeout(function(){ var i = $("#email"); if (i) i.focus({preventScroll:true}); }, 400);
});
function renderSignin(){
  var el = $("#signinBody");
  if (!configured) {
    el.innerHTML = '<p class="bad">This copy of the app isn\'t connected to its database yet. Fill in config.js (see SETUP.md).</p>';
    return;
  }
  var html = "";
  if (!signin.sent) {
    html += '<form id="emailForm" novalidate><label for="email">Your email</label>' +
      '<input id="email" type="email" autocomplete="email" inputmode="email" required value="' + esc(signin.email) + '" placeholder="you@example.com">' +
      '<button class="btn primary" type="submit"' + (signin.busy ? " disabled" : "") + '>Email me a sign-in link</button></form>' +
      '<div class="or"><span>or</span></div>' +
      '<button class="btn google" id="googleBtn" type="button"' + (signin.busy ? " disabled" : "") + '>Continue with Google</button>';
  } else {
    html += '<p>We sent a sign-in link to <strong>' + esc(signin.email) + '</strong>. Open it on this device.</p>' +
      '<form id="codeForm" novalidate><label for="code">If you installed the app, it\'s easier to type the 6-digit code from the same email:</label>' +
      '<input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" placeholder="123456">' +
      '<button class="btn primary" type="submit"' + (signin.busy ? " disabled" : "") + '>Sign in with code</button></form>' +
      '<p><button class="link" id="restartSignin" type="button">Use a different email</button></p>';
  }
  if (signin.msg) html += '<p class="msg' + (signin.bad ? " bad" : "") + '" aria-live="polite">' + esc(signin.msg) + '</p>';
  el.innerHTML = html;
}
$("#signinBody").addEventListener("submit", function(e){
  e.preventDefault();
  if (e.target.id === "emailForm") {
    var email = $("#email").value.trim().toLowerCase();
    signin.email = email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { signin.msg = "Please enter a valid email address."; signin.bad = true; return renderSignin(); }
    signin.busy = true; signin.msg = ""; renderSignin();
    sb.auth.signInWithOtp({email:email, options:{emailRedirectTo:appUrl(lsGet("arvocab-source") ? "?from=" + encodeURIComponent(lsGet("arvocab-source").src) : ""), shouldCreateUser:true}}).then(function(r){
      signin.busy = false;
      if (r.error) { signin.msg = /rate|seconds/i.test(r.error.message) ? "Please wait a minute before asking for another email." : "Couldn't send the email: " + r.error.message; signin.bad = true; }
      else { signin.sent = true; signin.msg = ""; }
      renderSignin();
    });
  } else if (e.target.id === "codeForm") {
    var code = $("#code").value.replace(/\D/g, "");
    if (code.length < 6) { signin.msg = "Type the 6-digit code from the email."; signin.bad = true; return renderSignin(); }
    signin.busy = true; signin.msg = ""; renderSignin();
    sb.auth.verifyOtp({email:signin.email, token:code, type:"email"}).then(function(r){
      signin.busy = false;
      if (r.error) { signin.msg = "That code didn't work. It may have expired; ask for a new email."; signin.bad = true; renderSignin(); }
    });
  }
});
$("#signinBody").addEventListener("click", function(e){
  if (e.target.id === "googleBtn") {
    signin.busy = true; renderSignin();
    sb.auth.signInWithOAuth({provider:"google", options:{redirectTo:appUrl()}}).then(function(r){
      if (r.error) { signin.busy = false; signin.msg = "Couldn't start Google sign-in: " + r.error.message; signin.bad = true; renderSignin(); }
    });
  } else if (e.target.id === "restartSignin") { signin = {email:signin.email, sent:false, busy:false, msg:"", bad:false}; renderSignin(); }
});

function startFor(u){
  if (user && user.id === u.id) return;
  user = {id:u.id, email:u.email};
  remind = null; renderRemind();
  signin = {email:"", sent:false, busy:false, msg:"", bad:false};
  $("#landing").hidden = true; $("#appMain").hidden = false;
  if (window.BA_TABS) BA_TABS.show({reader:readerAllowed(), admin:!!profile && (profile.role === "admin" || profile.role === "editor")});
  activity = {};
  serverProgressCount = -1; loadedOnline = false;
  outbox = {up:{}, del:{}, logs:[], wipe:false};
  prog.p = {};
  var cached = loadCached();
  renderAccount();
  route();
  if (cached) renderAll();
  else {
    $("#panel-cards").innerHTML = '<div class="panel-msg"><h2>Loading your words…</h2></div>';
    $("#todayStats").innerHTML = '<p class="muted">Loading your words…</p>';
  }
  var p = refresh();
  if (/[?&]checkout=success/.test(location.search)) {
    history.replaceState(null, "", location.pathname);
    p.then(function(){ if (!hasAccess()) waitForMembership(); else toast("Welcome! Every level is unlocked."); });
  }
}

/* ---------- online, offline, coming back to the app ---------- */
window.addEventListener("online", function(){ setSaveStatus(); flush(); if (user && !loadedOnline) refresh(); });
window.addEventListener("offline", function(){ setSaveStatus(); });
document.addEventListener("visibilitychange", function(){
  if (!user) return;
  if (document.visibilityState === "hidden") { clearTimeout(flushTimer); flush(); return; }
  if (Date.now() - lastPull > 30000 && outboxEmpty()) refresh();
  else flush();
  renderStairs();
  if (view === "home") renderHome();
  else if (prefs.mode === "cards" && !fc.revealed) { fc.cur = null; renderCard(); }
});

/* ---------- install and offline ---------- */
var installBar = $("#installBar"), installText = $("#installText"), installBtn = $("#installBtn");
var deferredPrompt = null;
var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function installDismissed(){ return !!lsGet("arvocab-install-dismissed"); }
window.addEventListener("beforeinstallprompt", function(e){
  e.preventDefault(); deferredPrompt = e;
  if (standalone || installDismissed()) return;
  installText.textContent = "Install this app for quick access from your home screen, even offline.";
  installBtn.hidden = false; installBar.hidden = false;
});
if (isIOS && !standalone && !installDismissed()) {
  installText.textContent = "To install on your iPhone or iPad, open this page in Safari, tap Share, then Add to Home Screen.";
  installBtn.hidden = true; $("#installLater").textContent = "Got it"; installBar.hidden = false;
}
installBtn.addEventListener("click", function(){
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(function(){ deferredPrompt = null; installBar.hidden = true; });
});
$("#installLater").addEventListener("click", function(){ lsSet("arvocab-install-dismissed", 1); installBar.hidden = true; });
window.addEventListener("appinstalled", function(){ installBar.hidden = true; });
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  window.addEventListener("load", function(){ navigator.serviceWorker.register("sw.js").catch(function(){}); });
}
if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist().catch(function(){}); } catch (e) {} }

// The Read page can be switched on for admins only (for testing) or everyone, in config.js.
function readerAllowed(){
  var access = CFG.readerAccess || "off";
  return access === "everyone" || (access === "admin" && !!profile && profile.role === "admin");
}
/* ---------- home dashboard ---------- */
// Learning words due later today can be done now (study learns ahead to the end of the day), so they count as work.
function learnAheadToday(q, now){ var dayEnd = dayStart(now) + DAY; return q.learnLater.filter(function(c){ return state(c.id).due < dayEnd; }).length; }
// Today's work left in deck d: reviews and learning words due, new words still allowed, and learning words due later today.
function deckToday(d, now){
  var keep = prefs.deck; prefs.deck = d;
  var q = queueInfo(now), work = q.learnDue.length + q.revDue.length + q.newShown + learnAheadToday(q, now);
  prefs.deck = keep;
  return {work: work};
}
var homeDeckPicked = false;
/* The next lesson from the Learn tab: the first published lesson the learner can open and hasn't finished.
   Shown from the saved copy straight away, then refreshed from the server once per visit. */
var lessonsFetched = false;
function renderLessonCard(){
  var box = $("#homeLesson"); if (!box || !user) return;
  var list = lsGet(ukey("lesson-index")) || [], done = lsGet(ukey("lesson-done")) || {};
  var next = list.filter(function(l){ return !done[l.id] && (l.is_free || hasAccess()); })[0];
  box.innerHTML = !next ? "" :
    '<a class="lesson-card" href="learn.html#l=' + esc(next.id) + '"><span class="lc-top"><span class="lc-tag">Next lesson · ' + LV[next.level] + ' · Unit ' + next.unit + '</span>' +
    '<span>' + next.questions + ' question' + (next.questions === 1 ? "" : "s") + '</span></span>' +
    '<span class="lc-ar" lang="ar">' + esc(next.title_ar) + '</span><b>' + esc(next.title_en) + '</b>' +
    '<span class="btn primary">Start lesson</span></a>';
  if (lessonsFetched) return;
  lessonsFetched = true;
  Promise.all([check(sb.rpc("lesson_index")), check(sb.from("lesson_progress").select("lesson_id,score,total"))]).then(function(r){
    var d = {}; (r[1].data || []).forEach(function(p){ d[p.lesson_id] = {score:p.score, total:p.total}; });
    lsSet(ukey("lesson-index"), r[0].data || []); lsSet(ukey("lesson-done"), d);
    if (view === "home") renderLessonCard();
  }).catch(function(){ lessonsFetched = false; });   // lessons not set up yet, or offline
}
document.addEventListener("click", function(e){
  var b = e.target.closest("[data-home-deck]");
  if (b) { setDeck(b.dataset.homeDeck); renderHome(); }
});
function renderHome(){
  if (!user) return;
  var now = Date.now(), today = dayNum(now);
  $("#greetDate").textContent = new Date(now).toLocaleDateString([], {weekday:"long", day:"numeric", month:"long"});

  // Offer to bring over progress from the earlier app (the import itself lives on the flashcards screen).
  $("#homeImport").innerHTML = importState
    ? '<div class="import-banner"><span>Used the earlier version of this app? Bring your progress with you.</span><a class="btn primary" href="#study/cards">Bring it over</a></div>'
    : "";

  renderLessonCard();
  if (!CARDS.length) return;
  if (!DECKS[prefs.deck]) prefs.deck = "main";
  // Today shows one deck at a time, with a switch that says how much is left in each. On the first look this
  // visit, it opens on a deck that still has work if the chosen one is finished.
  var left = {};
  Object.keys(DECKS).forEach(function(d){ left[d] = deckToday(d, now).work; });
  if (!homeDeckPicked && !left[prefs.deck]) {
    var other = Object.keys(DECKS).filter(function(d){ return left[d]; })[0];
    if (other) setDeck(other);
  }
  homeDeckPicked = true;
  $("#todayDecks").innerHTML = Object.keys(DECKS).map(function(d){
    return '<button type="button" role="tab" data-home-deck="' + d + '" aria-selected="' + (d === prefs.deck) + '">' + esc(DECKS[d].name) +
      ' <span class="deck-left">' + (left[d] ? left[d] : "✓") + '</span></button>';
  }).join("");
  var q = queueInfo(now);
  var due = q.learnDue.length + q.revDue.length, fresh = q.newShown, learning = q.learnDue.length + q.learnLater.length;
  $("#todayStats").innerHTML =
    '<div class="stat due"><b>' + due + '</b><span>to review</span></div>' +
    '<div class="stat new"><b>' + fresh + '</b><span>new words</span></div>' +
    '<div class="stat lrn"><b>' + learning + '</b><span>learning</span></div>';
  var ahead = learnAheadToday(q, now), work = due + fresh + ahead;
  $("#todayEta").textContent = work ? "about " + Math.max(1, Math.round(((due + ahead) * 8 + fresh * 15) / 60)) + " min" : "";
  var cta;
  if (work) cta = '<a class="btn primary" href="#study/cards">' + (due ? "Start studying" : fresh ? "Learn new words" : "Finish today's words") + '</a><a class="btn" href="#study/quiz">Quiz</a>';
  else {
    var tomorrow = dayStart(now) + DAY;
    var nextDue = q.pool.map(function(c){ var s = state(c.id); return !s ? Infinity : heldTillTomorrow(s, now) ? tomorrow : s.due; }).reduce(function(a, b){ return Math.min(a, b); }, Infinity);
    cta = '<p class="note">All caught up' + (q.held ? ". " + q.held + " word" + (q.held === 1 ? "" : "s") + " you're learning come" + (q.held === 1 ? "s" : "") + " back tomorrow"
        : nextDue < Infinity ? ". Next review " + whenLabel(nextDue, now) : "") + '.</p>' +
      '<a class="btn" href="#study/cards">Learn more words</a><a class="btn" href="#study/quiz">Quiz</a>';
  }
  if (onlyLockedChosen()) cta = '<p class="note">The levels you\'ve chosen are for members.</p><a class="btn primary" href="#study/cards">Choose levels</a>';
  $("#todayCta").innerHTML = cta;
  // Today's buttons go straight into the deck shown, without asking which deck.
  $("#todayCta").querySelectorAll("a[href^='#study']").forEach(function(a){ a.dataset.deck = prefs.deck; });

  // Streak: days in a row with at least one answer (today counts once you've answered something).
  var counts = activityCounts(), d = counts[today] ? today : today - 1, streak = 0;
  while (counts[d]) { streak++; d--; }
  $("#streakNum").textContent = streak;
  var week = 0, max = 1, bars = "";
  for (var i = 29; i >= 0; i--) max = Math.max(max, counts[today - i] || 0);
  for (var j = 29; j >= 0; j--) {
    var n = counts[today - j] || 0;
    if (j < 7) week += n;
    bars += '<i class="' + (n ? "" : "zero") + (j === 0 ? " now" : "") + '" style="height:' + (n ? Math.max(8, Math.round(n / max * 100)) : 6) + '%" title="' + n + ' answer' + (n === 1 ? "" : "s") + '"></i>';
  }
  $("#activityBars").innerHTML = bars;
  $("#weekCount").textContent = week + " answer" + (week === 1 ? "" : "s") + " this week";
  $("#streakHint").textContent = counts[today]
    ? (work ? "Good start today. " + work + " more to go." : "Done for today. Come back tomorrow to keep your streak.")
    : streak ? "Study today to keep your streak going." : "Answer a card today to start a streak.";

  // Library and Admin live in the tab bar.
  if (window.BA_TABS) BA_TABS.show({reader:readerAllowed(), admin:!!profile && (profile.role === "admin" || profile.role === "editor")});

  // Progress by level.
  var learnedAll = 0, html = "";
  for (var lv = 1; lv <= 6; lv++) {
    var total = levelTotal(lv) + mineCount(lv);
    if (!total) continue;
    var learned = CARDS.filter(function(c){ return c.lv === lv && isKnown(state(c.id)); }).length;
    learnedAll += learned;
    var locked = isLocked(lv);
    html += '<div class="lvl lv' + lv + (locked ? " locked" : "") + '"><b>' + LV[lv] + '</b><span class="track"><i style="width:' + Math.round(learned / total * 100) + '%"></i></span>' +
      '<span class="n">' + (locked ? (learned ? learned + " · " : "") + "Members" : learned + " / " + total) + '</span></div>';
  }
  $("#levelBars").innerHTML = html;
  var hard = CARDS.filter(function(c){ return isHard(state(c.id)); }).length;
  $("#hardWords").innerHTML = hard ? '<div class="hard-note"><span><b>' + hard + ' hard word' + (hard === 1 ? "" : "s") + '</b>: forgotten ' + HARD_LAPSES + '+ times. Give ' + (hard === 1 ? "it" : "them") + ' extra practice.</span>' +
    '<span><button class="btn" data-act="practise-hard" data-to="quiz" type="button">Quiz</button> <button class="btn" data-act="practise-hard" data-to="cards" type="button">Review</button></span></div>' : "";
  $("#learnedTotal").textContent = learnedAll + " word" + (learnedAll === 1 ? "" : "s") + " known";
}

/* ---------- screens: home (dashboard) and study (flashcards, quiz, word list) ---------- */
var view = "home";
/* Choosing a deck: pressing study on the home screen asks which deck, unless the link already names one. */
var pendingStudy = null;
function chooseDeck(hash){
  pendingStudy = hash;
  var box = $("#deckChooser");
  box.querySelectorAll("[data-deck]").forEach(function(b){
    var d = b.dataset.deck;
    b.classList.toggle("current", d === prefs.deck);
    b.querySelector("small").textContent = DECKS[d].sub + " · " + deckSize(d) + " words";
  });
  box.hidden = false;
  box.querySelector("[data-deck='" + prefs.deck + "']").focus();
}
function closeChooser(){ $("#deckChooser").hidden = true; pendingStudy = null; }
function setDeck(d){
  if (prefs.deck === d) return;
  prefs.deck = d; prefs.source = "all"; fc.cur = null; fc.revealed = false; fc.undo = null; savePrefs();
  newSel.value = String(deckNewPerDay());
  if (CARDS.length) renderStairs();   // levels for General Vocabulary, categories for Islamic terms
}
document.addEventListener("click", function(e){
  var a = e.target.closest("#home a[href^='#study']");
  if (a) {
    e.preventDefault();
    if (a.dataset.deck) { setDeck(a.dataset.deck); location.hash = a.getAttribute("href"); }
    else chooseDeck(a.getAttribute("href"));
    return;
  }
  var pick = e.target.closest("#deckChooser [data-deck]");
  if (pick) { var h = pendingStudy || "#study/cards"; setDeck(pick.dataset.deck); closeChooser(); if (location.hash === h) route(); else location.hash = h; return; }
  if (e.target.closest("[data-act=close-chooser]") || e.target.id === "deckChooser") closeChooser();
  if (e.target.closest("[data-act=switch-deck]")) { e.preventDefault(); chooseDeck(location.hash || "#study/cards"); }
});
document.addEventListener("keydown", function(e){ if (e.key === "Escape" && !$("#deckChooser").hidden) closeChooser(); });

function route(){
  if (!user) return;
  var m = /^#study(?:\/(cards|quiz|list))?$/.exec(location.hash);
  showView(m ? "study" : "home", m && m[1]);
}
function showView(v, mode){
  var changed = view !== v;
  view = v;
  $("#home").hidden = v !== "home";
  $("#study").hidden = v !== "study";
  updateNav();
  if (v === "study") { $("#deckName").textContent = DECKS[prefs.deck].name; setMode(mode || prefs.mode); }
  else renderHome();
  if (changed) window.scrollTo(0, 0);
}
// The top bar only has Home (on the study screens); everything else is reached from the home screen's tiles.
function updateNav(){
  $("#navHome").hidden = view !== "study";
  $("#topnav").hidden = $("#navHome").hidden;
}
window.addEventListener("hashchange", route);

function renderAll(){
  var reader = readerAllowed();
  $("#topSub").hidden = false; updateNav();
  // Saved words only exist once someone has used the Read page.
  var anyMine = CARDS.some(function(c){ return c.mine; }), anyHard = CARDS.some(function(c){ return isHard(state(c.id)); });
  $("#srcMine").hidden = !reader && !anyMine;
  $("#srcWrap").hidden = !reader && !anyMine && !anyHard;
  if (($("#srcWrap").hidden && prefs.source !== "all") || ($("#srcMine").hidden && prefs.source === "mine")) { prefs.source = "all"; $("#srcSel").value = "all"; savePrefs(); }
  $("#total").textContent = summary.length ? summary.reduce(function(n, s){ return n + s.total; }, 0) : CARDS.length;
  renderStairs();
  renderAccount();
  qz.qs = null;
  if (view === "study") setMode(prefs.mode); else renderHome();
}

if (!configured) { showSignedOut(); return; }
// Supabase keeps the session here. Offline, an expired session can't be refreshed, but the
// person is still the same, so we let them keep studying what's cached on this device.
function storedUser(){
  try {
    var ref = new URL(CFG.supabaseUrl).hostname.split(".")[0];
    var t = JSON.parse(localStorage.getItem("sb-" + ref + "-auth-token"));
    return t && t.user && t.user.id ? t.user : null;
  } catch (e) { return null; }
}
sb.auth.onAuthStateChange(function(event, session){
  // Run outside the auth callback so Supabase calls made from here don't wait on its lock.
  setTimeout(function(){
    if (session && session.user) startFor(session.user);
    else if (event === "SIGNED_OUT") showSignedOut();
  }, 0);
});
sb.auth.getSession().then(function(r){
  var s = r.data && r.data.session;
  if (s && s.user) return startFor(s.user);
  var cachedUser = storedUser();
  if (cachedUser && (!navigator.onLine || r.error)) startFor(cachedUser);
  else if (!user) showSignedOut();
}).catch(function(){
  var cachedUser = storedUser();
  if (cachedUser) startFor(cachedUser); else showSignedOut();
});
})();
