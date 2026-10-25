(function(){
"use strict";
var CFG = window.ARVOCAB_CONFIG || {};
var LV = ["", "A1", "A2", "B1", "B2", "C1", "C2"];
var TY = {n:"noun", v:"verb", a:"adjective", d:"adverb", p:"phrase", r:"particle"};
var $ = function(s){ return document.querySelector(s); };
var main = $("#main"), pop = $("#pop");
var PAGE = 1000;

function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(ch){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]; }); }
function lsGet(k){ try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function check(q){ return q.then(function(r){ if (r.error) throw r.error; return r; }); }

if (!CFG.supabaseUrl || !CFG.supabaseKey || !window.supabase) { main.innerHTML = '<div class="panel"><p>This copy of the app isn\'t connected yet.</p></div>'; return; }
var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
var user = null, member = null, profile = null;
var cards = [], prog = {};
var library = [], readable = new Set(), mine = [];
var allowance = null; // lookups left today, for free accounts
function ukey(k){ return "arvocab-u:" + user.id + ":" + k; }

/* ---------- membership (same rules as the flashcards) ---------- */
function hasAccess(){
  if (profile && profile.role === "admin") return true;
  var m = member; if (!m) return false;
  var end = m.current_period_end ? Date.parse(m.current_period_end) : null, now = Date.now();
  if ((m.status === "active" || m.status === "comp") && (end == null || end > now)) return true;
  return (m.status === "canceled" || m.status === "past_due") && end != null && end > now;
}
var FREE_LOOKUPS = 10;
// Set in config.js: "admin" (only admins, for testing), "everyone", or "off".
function readerAllowed(){
  var access = CFG.readerAccess || "off";
  return access === "everyone" || (access === "admin" && !!profile && profile.role === "admin");
}

/* ---------- matching tapped words to the deck and saved words (wordmatch.js) ---------- */
var W = window.makeWordMatcher(function(){ return cards; }, function(){ return prog; }, +CFG.knownDays || 21);
var LETTER = W.LETTER, WORD_RE = W.WORD_RE, IS_WORD = W.IS_WORD, normKey = W.normKey;
function indexCards(){ W.index(); }
function match(text){ return W.match(text); }
function stage(card){ return W.stage(card); }
function cls(card){ return W.cls(card); }

/* ---------- loading ---------- */
function toCard(r){ return {id:r.id, ar:r.arabic, en:r.english, lv:r.level, ty:r.word_type, ex:Array.isArray(r.examples) ? r.examples : [], so:r.sort_order, free:r.is_free, mine:/^u-/.test(r.id)}; }
function fetchAll(table, cols, order){
  var out = [];
  function page(from){
    return check(sb.from(table).select(cols).order(order, {ascending:true}).range(from, from + PAGE - 1)).then(function(r){
      out = out.concat(r.data || []);
      return r.data && r.data.length === PAGE ? page(from + PAGE) : out;
    });
  }
  return page(0);
}
function loadCached(){
  cards = (lsGet(ukey("cards")) || []).map(function(c){ c.mine = /^u-/.test(c.id); return c; });
  prog = lsGet(ukey("prog")) || {};
  member = lsGet(ukey("member")); profile = lsGet(ukey("profile"));
  indexCards();
}
function loadRemote(){
  return Promise.all([
    fetchAll("cards", "id,level,word_type,arabic,english,examples,sort_order,is_free,is_active", "sort_order"),
    fetchAll("progress", "card_id,state", "card_id"),
    check(sb.from("memberships").select("*").eq("user_id", user.id).maybeSingle()),
    check(sb.from("profiles").select("id,email,role").eq("id", user.id).maybeSingle()),
    check(sb.rpc("library_index")),
    check(sb.from("texts").select("id,owner_id,title,level,is_free,created_at").order("created_at", {ascending:false}))
  ]).then(function(r){
    cards = r[0].filter(function(c){ return c.is_active !== false; }).map(toCard);   // editors can also see retired words
    // Keep any answers the flashcards haven't sent yet: they're in the local copy.
    var local = lsGet(ukey("prog")) || {};
    prog = {}; r[1].forEach(function(x){ prog[x.card_id] = x.state; });
    Object.keys(local).forEach(function(id){ prog[id] = local[id]; });
    member = r[2].data || null; profile = r[3].data || null;
    library = r[4].data || [];
    readable = new Set(r[5].data.filter(function(t){ return !t.owner_id; }).map(function(t){ return t.id; }));
    mine = r[5].data.filter(function(t){ return t.owner_id === user.id; });
    lsSet(ukey("cards"), cards); lsSet(ukey("member"), member); lsSet(ukey("profile"), profile);
    if (window.BA_TABS) BA_TABS.show({admin:!!profile && (profile.role === "admin" || profile.role === "editor")});
    lsSet(ukey("read-index"), {library:library, readable:Array.from(readable), mine:mine});
    indexCards();
    if (!hasAccess()) return sb.from("lookup_usage").select("lookups").eq("user_id", user.id).eq("day", new Date().toISOString().slice(0, 10)).maybeSingle()
      .then(function(u){ allowance = Math.max(0, FREE_LOOKUPS - ((u.data && u.data.lookups) || 0)); }, function(){});
  });
}

/* ---------- books: library texts sharing a book title, one chapter each ---------- */
var readDone = {};
function chaptersOf(book){
  return library.filter(function(t){ return t.book === book; }).map(function(t, i){ return {t:t, i:i}; })
    .sort(function(a, b){ return (a.t.chapter == null ? 1e9 : a.t.chapter) - (b.t.chapter == null ? 1e9 : b.t.chapter) || a.i - b.i; })
    .map(function(x){ return x.t; });
}
function levelRange(list){
  var lv = list.map(function(t){ return t.level; }).filter(Boolean);
  if (!lv.length) return "";
  var lo = Math.min.apply(null, lv), hi = Math.max.apply(null, lv);
  return lo === hi ? LV[lo] : LV[lo] + "–" + LV[hi];
}
function libEntry(id){ return library.filter(function(t){ return t.id === id; })[0] || null; }
function chLabel(c, n){ return "Chapter " + (c.chapter != null ? c.chapter : n); }
function markRead(id){ if (!readDone[id]) { readDone[id] = 1; lsSet(ukey("read-done"), readDone); } }
function renderBook(book){
  closePop();
  var ch = chaptersOf(book), free = !hasAccess();
  if (!ch.length) { main.innerHTML = '<div class="panel"><p>That book isn\'t available.</p><div class="row"><button class="btn" data-act="home" type="button">Back to texts</button></div></div>'; return; }
  var next = ch.filter(function(c){ return readable.has(c.id) && !readDone[c.id]; })[0];
  var html = '<div class="reader-head"><button class="btn small" data-act="home" type="button">← Texts</button><h2>📖 ' + esc(book) + '</h2><span></span></div>';
  html += '<div class="panel"><p>' + ch.length + ' chapter' + (ch.length === 1 ? "" : "s") + (levelRange(ch) ? " · " + levelRange(ch) : "") + '</p>';
  if (next) html += '<div class="row" style="margin:0 0 12px"><button class="btn primary" data-text="' + next.id + '" type="button">' +
    (ch.some(function(c){ return readDone[c.id]; }) ? "Continue: " : "Start: ") + esc(chLabel(next, ch.indexOf(next) + 1)) + '</button></div>';
  html += '<div class="list">';
  ch.forEach(function(c, i){
    var open = readable.has(c.id);
    html += '<button class="item' + (open ? "" : " locked") + '" data-text="' + c.id + '" type="button"><span><small>' + esc(chLabel(c, i + 1)) + '</small><br><span class="t">' + esc(c.title) + '</span>' +
      (c.level ? ' <small>' + LV[c.level] + '</small>' : "") + '</span>' +
      (!open ? '<span class="tag">Members</span>' : readDone[c.id] ? '<span class="tag free">✓ Read</span>' : c.is_free && free ? '<span class="tag free">Free</span>' : "") + '</button>';
  });
  html += '</div></div>';
  if (free && ch.some(function(c){ return !readable.has(c.id); }))
    html += '<div class="panel"><p>The rest of this book is for members.</p><div class="row" style="margin-top:0"><button class="btn primary small" data-act="subscribe" type="button">Subscribe' + (CFG.priceLabel ? " · " + esc(CFG.priceLabel) : "") + '</button></div></div>';
  main.innerHTML = html;
}
// Previous / next chapter buttons under a chapter.
function chapterNav(id){
  var e = libEntry(id); if (!e || !e.book) return "";
  var ch = chaptersOf(e.book), i = ch.indexOf(e), prev = ch[i - 1], next = ch[i + 1];
  var html = '<div class="chnav">';
  html += prev ? '<button class="btn" data-text="' + prev.id + '" type="button">← ' + esc(chLabel(prev, i)) + '</button>' : '<span></span>';
  if (!next) html += '<button class="btn" data-book="' + esc(e.book) + '" type="button">Finished · back to the book</button>';
  else if (readable.has(next.id)) html += '<button class="btn primary" data-text="' + next.id + '" type="button">' + esc(chLabel(next, i + 2)) + ' →</button>';
  else html += '<button class="btn primary" data-act="subscribe" type="button">' + esc(chLabel(next, i + 2)) + ' is for members · Subscribe</button>';
  return html + '</div>';
}

/* ---------- library and own texts ---------- */
function renderHome(){
  closePop();
  var free = !hasAccess();
  var html = "";
  if (free) html += '<div class="panel"><h2>Free account</h2><p>You get ' + FREE_LOOKUPS + ' word lookups a day and the free texts. Members get unlimited lookups and the whole library.' +
    (allowance != null ? " " + allowance + " lookup" + (allowance === 1 ? "" : "s") + " left today." : "") + '</p>' +
    '<div class="row" style="margin-top:0"><button class="btn primary small" data-act="subscribe" type="button">Subscribe' + (CFG.priceLabel ? " · " + esc(CFG.priceLabel) : "") + '</button></div></div>';
  html += '<div class="panel"><h2>Library</h2><p>Texts chosen for learners, by level.</p><div class="list">';
  if (!library.length) html += '<p class="msg">No texts yet. Check back soon.</p>';
  var shownBooks = {};
  library.forEach(function(t){
    if (t.book) {
      if (shownBooks[t.book]) return; shownBooks[t.book] = 1;
      var ch = chaptersOf(t.book), open = ch.filter(function(c){ return readable.has(c.id); }).length;
      var done = ch.filter(function(c){ return readDone[c.id]; }).length;
      html += '<button class="item' + (open ? "" : " locked") + '" data-book="' + esc(t.book) + '" type="button"><span><span class="t">📖 ' + esc(t.book) + '</span>' +
        ' <small>' + ch.length + ' chapter' + (ch.length === 1 ? "" : "s") + (levelRange(ch) ? " · " + levelRange(ch) : "") + (done ? " · " + done + " read" : "") + '</small></span>' +
        (!open ? '<span class="tag">Members</span>' : open < ch.length && free ? '<span class="tag free">Free taster</span>' : "") + '</button>';
      return;
    }
    var isOpen = readable.has(t.id);
    html += '<button class="item' + (isOpen ? "" : " locked") + '" data-text="' + t.id + '" type="button"><span><span class="t">' + esc(t.title) + '</span>' +
      (t.level ? ' <small>' + LV[t.level] + '</small>' : "") + '</span>' +
      (isOpen ? (t.is_free && free ? '<span class="tag free">Free</span>' : "") : '<span class="tag">Members</span>') + '</button>';
  });
  html += '</div></div>';
  html += '<div class="panel paste"><h2>Read your own text</h2><p>Paste any Arabic text: an article, a hadith, your lesson notes. It\'s saved privately to your account.</p>' +
    '<label for="pTitle">Title</label><input id="pTitle" maxlength="200" placeholder="e.g. Lesson 12 reading">' +
    '<label for="pBody">Arabic text</label><textarea id="pBody" dir="rtl" lang="ar" maxlength="20000" placeholder="الصق النص هنا"></textarea>' +
    '<div class="row"><button class="btn primary" id="pGo" type="button">Start reading</button><span class="msg" id="pMsg"></span></div></div>';
  if (mine.length) {
    html += '<div class="panel"><h2>Your texts</h2><div class="list">';
    mine.forEach(function(t){
      html += '<div class="item"><button class="link" data-text="' + t.id + '" type="button" style="text-decoration:none;color:var(--ink);font-weight:600;text-align:left">' + esc(t.title) + '</button>' +
        '<button class="link" data-del="' + t.id + '" type="button" style="color:var(--wrong)">Delete</button></div>';
    });
    html += '</div></div>';
  }
  main.innerHTML = html;
}
main.addEventListener("click", function(e){
  var b = e.target.closest("[data-book]");
  if (b) { location.hash = "b=" + encodeURIComponent(b.dataset.book); return; }
  var t = e.target.closest("[data-text]");
  if (t) {
    var id = t.dataset.text;
    var inLib = library.some(function(x){ return x.id === id; });
    if (inLib && !readable.has(id)) { toast("This text is for members.", true); return; }
    location.hash = "t=" + id; return;
  }
  var d = e.target.closest("[data-del]");
  if (d) {
    if (d.dataset.armed !== "1") { d.dataset.armed = "1"; d.textContent = "Tap again to delete"; return; }
    check(sb.from("texts").delete().eq("id", d.dataset.del)).then(function(){
      mine = mine.filter(function(x){ return x.id !== d.dataset.del; }); renderHome();
    }).catch(function(err){ toast("Couldn't delete: " + err.message); });
    return;
  }
  if (e.target.id === "pGo") return startPasted();
  if (e.target.closest("[data-act=subscribe]")) return subscribe(e.target.closest("[data-act=subscribe]"));
  if (e.target.closest("[data-act=home]")) { location.hash = ""; return; }
});
function startPasted(){
  var body = $("#pBody").value.trim(), title = $("#pTitle").value.trim() || body.replace(/\s+/g, " ").slice(0, 40);
  var msg = $("#pMsg");
  if (!new RegExp("[" + LETTER + "]").test(body)) { msg.textContent = "Paste some Arabic text first."; msg.className = "msg bad"; return; }
  $("#pGo").disabled = true; msg.textContent = "Saving…"; msg.className = "msg";
  check(sb.from("texts").insert({owner_id:user.id, title:title, body:body}).select("id,owner_id,title,level,is_free,created_at").single()).then(function(r){
    mine.unshift(r.data); cacheText(r.data.id, {title:title, body:body});
    location.hash = "t=" + r.data.id;
  }).catch(function(){
    // Offline or over the limit: read it anyway without saving.
    cacheText("draft", {title:title, body:body}); location.hash = "t=draft";
  });
}
function cacheText(id, t){
  var all = lsGet(ukey("texts")) || {}; all[id] = t;
  var keys = Object.keys(all); if (keys.length > 12) delete all[keys[0]];
  lsSet(ukey("texts"), all);
}
function getText(id){
  var cached = (lsGet(ukey("texts")) || {})[id];
  if (id === "draft") return Promise.resolve(cached || null);
  return check(sb.from("texts").select("id,title,body,level").eq("id", id).maybeSingle()).then(function(r){
    if (r.data) cacheText(id, {title:r.data.title, body:r.data.body});
    return r.data || null;
  }).catch(function(){ return cached || null; });
}

/* ---------- the reader ---------- */
var sentences = [], textId = null; // textId: the library text or book chapter being read, if it is one
function renderText(t, tid){
  textId = tid && libEntry(tid) ? tid : null;
  closePop();
  if (!t) { main.innerHTML = '<div class="panel"><p>That text isn\'t available. It may be for members only, or deleted.</p><div class="row"><button class="btn" data-act="home" type="button">Back to texts</button></div></div>'; return; }
  sentences = [""];
  var wi = 0, si = 0, html = "";
  String(t.body).split(/\n\s*\n|\r?\n/).forEach(function(par){
    if (!par.trim()) return;
    html += "<p>";
    (par.match(WORD_RE) || []).forEach(function(tok){
      if (IS_WORD.test(tok)) {
        var hit = match(tok);
        html += '<span class="w ' + cls(hit && hit.card) + '" data-i="' + (wi++) + '" data-s="' + si + '">' + esc(tok) + '</span>';
        sentences[si] += tok;
      } else {
        html += esc(tok);
        sentences[si] += tok;
        if (/[.!?؟؛۔]/.test(tok)) { si++; sentences[si] = ""; }
      }
    });
    html += "</p>"; si++; sentences[si] = "";
  });
  var free = !hasAccess(), entry = tid ? libEntry(tid) : null, book = entry && entry.book;
  var back = book ? '<button class="btn small" data-book="' + esc(book) + '" type="button">← ' + esc(book) + '</button>' : '<button class="btn small" data-act="home" type="button">← Texts</button>';
  var heading = book ? '<small style="display:block;color:var(--muted);font-family:var(--ui);font-size:.8rem;font-weight:600">' + esc(chLabel(entry, chaptersOf(book).indexOf(entry) + 1)) + '</small>' : "";
  main.innerHTML = '<div class="reader-head">' + back + '<h2>' + heading + esc(t.title) + '</h2>' +
    '<span class="allow" id="allow">' + (free && allowance != null ? allowance + " free lookups left today" : "") + '</span></div>' +
    '<div class="text" id="text" lang="ar" dir="rtl">' + html + '</div>' +
    '<div class="legend"><span><i style="border-color:var(--known)"></i>Known</span><span><i style="border-color:color-mix(in srgb,var(--known) 50%,transparent)"></i>Young</span><span><i style="border-color:var(--learning)"></i>Learning</span><span><i style="border-color:var(--lapis)"></i>Saved</span><span>Tap a word. For several, drag across them (on a phone, hold a moment first).</span></div>' +
    (tid ? chapterNav(tid) : "");
}
function refreshUnderlines(){
  document.querySelectorAll("#text .w").forEach(function(el){
    var hit = match(el.textContent); el.className = "w " + cls(hit && hit.card) + (el.classList.contains("sel") ? " sel" : "");
  });
}
function sentenceOf(el){ var s = el && el.closest(".w") ? +el.closest(".w").dataset.s : -1; return s > -1 ? sentences[s].replace(/\s+/g, " ").trim() : ""; }
function clearSel(){ document.querySelectorAll(".w.sel").forEach(function(el){ el.classList.remove("sel"); }); }

/* Word selection. The browser's own text highlighting is switched off on the text (see read.html);
   instead: click or tap a word; drag across words with a mouse; on a phone, press and hold a word
   briefly, then slide. The popup's "+ next word" / "+ previous word" buttons grow a selection too. */
var MAX_WORDS = 30;
function wordEls(){ return Array.prototype.slice.call(document.querySelectorAll("#text .w")); }
function showRange(a, b){
  clearSel();
  wordEls().slice(Math.min(a, b), Math.max(a, b) + 1).forEach(function(el){ el.classList.add("sel"); });
}
function lookupRange(a, b){
  var els = wordEls(), lo = Math.min(a, b), hi = Math.max(a, b);
  if (hi - lo >= MAX_WORDS) { hi = lo + MAX_WORDS - 1; toast("That's a long selection, so only the first " + MAX_WORDS + " words were used."); }
  showRange(lo, hi);
  var text = els.slice(lo, hi + 1).map(function(el){ return el.textContent; }).join(" ");
  lookup(text, sentenceOf(els[lo]), [lo, hi]);
}
var drag = null; // {start, end, active, touch, x, y, id, timer}
main.addEventListener("pointerdown", function(e){
  var w = e.target.closest("#text .w"); if (!w || e.button > 0) return;
  var i = +w.dataset.i, touch = e.pointerType === "touch";
  drag = {start:i, end:i, active:!touch, touch:touch, x:e.clientX, y:e.clientY, id:e.pointerId};
  if (!touch) e.preventDefault();
  // On a phone, a short hold starts a multi-word selection; moving straight away is a scroll.
  if (touch) drag.timer = setTimeout(function(){
    if (!drag) return;
    drag.active = true; showRange(drag.start, drag.start);
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch (err) {} }
  }, 350);
});
document.addEventListener("pointermove", function(e){
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.active) {
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 10) { clearTimeout(drag.timer); drag = null; }
    return;
  }
  var el = document.elementFromPoint(e.clientX, e.clientY), w = el && el.closest ? el.closest("#text .w") : null;
  if (w && +w.dataset.i !== drag.end) { drag.end = +w.dataset.i; showRange(drag.start, drag.end); }
});
// While selecting on a phone, stop the page from scrolling under the finger.
main.addEventListener("touchmove", function(e){ if (drag && drag.active) e.preventDefault(); }, {passive:false});
main.addEventListener("contextmenu", function(e){ if (e.target.closest("#text")) e.preventDefault(); });
function endDrag(e){
  if (!drag || e.pointerId !== drag.id) return;
  clearTimeout(drag.timer);
  var d = drag; drag = null;
  if (e.type === "pointercancel") { if (d.active) clearSel(); return; }
  lookupRange(d.start, d.end);
}
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);

/* ---------- the popup ---------- */
var cur = null; // {text, sentence, card, translation, state}
function closePop(){ pop.hidden = true; cur = null; clearSel(); }
// Put the popup a little below the selected words, centred on the last line of the selection,
// or above the first line when there isn't room below. It always stays inside the screen.
var GAP = 12, EDGE = 12;
function placePop(){
  if (pop.hidden) return;
  var rects = [];
  document.querySelectorAll("#text .w.sel").forEach(function(el){ Array.prototype.forEach.call(el.getClientRects(), function(r){ rects.push(r); }); });
  var vw = document.documentElement.clientWidth, vh = window.innerHeight;
  var w = pop.offsetWidth, h = pop.offsetHeight, sx = window.scrollX, sy = window.scrollY;
  if (!rects.length) {
    // Nothing on screen to point at: sit near the bottom of the screen.
    pop.classList.remove("above"); pop.style.setProperty("--caret", "-100px");
    pop.style.left = (sx + (vw - w) / 2) + "px"; pop.style.top = (sy + vh - h - EDGE) + "px";
    return;
  }
  var bottom = Math.max.apply(null, rects.map(function(r){ return r.bottom; }));
  var top = Math.min.apply(null, rects.map(function(r){ return r.top; }));
  var lastLine = rects.filter(function(r){ return r.bottom >= bottom - 4; });
  var firstLine = rects.filter(function(r){ return r.top <= top + 4; });
  function middle(line){ var l = Math.min.apply(null, line.map(function(r){ return r.left; })), rr = Math.max.apply(null, line.map(function(r){ return r.right; })); return (l + rr) / 2; }
  var roomBelow = vh - bottom - GAP - EDGE, roomAbove = top - GAP - EDGE;
  var above = h > roomBelow && roomAbove > roomBelow;
  var cx = middle(above ? firstLine : lastLine);
  var left = Math.min(Math.max(cx - w / 2, EDGE), vw - w - EDGE);
  var y = above ? top - GAP - h : bottom + GAP;
  pop.classList.toggle("above", above);
  pop.style.left = (sx + left) + "px";
  pop.style.top = (sy + y) + "px";
  pop.style.setProperty("--caret", Math.min(Math.max(cx - left, 22), w - 22) + "px");
  // Not enough room either way (very small screens): scroll just enough to show the whole popup.
  if (!above && y + h > vh - EDGE) window.scrollBy({top: y + h - vh + EDGE, behavior: "smooth"});
}
window.addEventListener("resize", placePop);
function lookup(text, sentence, range){
  text = String(text).trim(); if (!text) return;
  var hit = match(text);
  cur = {text:text, sentence:sentence, card:hit ? hit.card : null, meaning:hit ? hit.en : null, partOf:!!hit && !hit.full,
    translation:null, state:hit ? "known" : "loading", range:range || null};
  renderPop();
  if (!hit) translate();
}
function translate(){
  var c = cur; c.state = "loading"; renderPop();
  if (!navigator.onLine) { c.state = "offline"; renderPop(); return; }
  sb.functions.invoke("translate", {body:{text:c.text, sentence:c.sentence || "", text_id:textId}}).then(function(r){
    if (c !== cur) return;
    var d = r.data;
    if (r.error && r.error.context && typeof r.error.context.json === "function") {
      return r.error.context.json().then(function(body){ handleTranslate(c, body, r.error.context.status); }, function(){ c.state = "error"; renderPop(); });
    }
    handleTranslate(c, d, r.error ? 500 : 200);
  }).catch(function(){ if (c === cur) { c.state = "error"; renderPop(); } });
}
function handleTranslate(c, d, status){
  if (c !== cur) return;
  if (d && d.error === "limit") { c.state = "limit"; allowance = 0; updateAllowance(); renderPop(); return; }
  if (!d || (!d.translation && !d.sentence_translation)) { c.state = "error"; renderPop(); return; }
  // "ai": Google only spelled the word out, so this is Gemini's meaning in the sentence.
  // "sentence": no meaning for the word alone, so this is the whole sentence; the learner types the word's meaning to save it.
  c.source = d.source || "google"; c.sentenceTr = d.sentence_translation || null;
  c.translation = d.translation || ""; c.state = "translated";
  if (!c.translation) { c.editing = true; c.edited = ""; }
  if (!d.member && typeof d.remaining === "number") { allowance = d.remaining; updateAllowance(); }
  renderPop();
}
function updateAllowance(){ var el = $("#allow"); if (el && !hasAccess() && allowance != null) el.textContent = allowance + " free lookup" + (allowance === 1 ? "" : "s") + " left today"; }
function renderPop(){
  var c = cur; if (!c) return;
  var html = '<div class="head"><div class="ar" lang="ar" dir="rtl">' + esc(c.text) + '</div><button class="x" data-act="close" type="button" aria-label="Close">×</button></div>';
  if (c.state === "known") {
    var k = c.card;
    // A word that's one part of a combined card ("التالي × السابق") is labelled "from the card …".
    var where = c.partOf ? " · from the card " : normKey(k.ar) !== normKey(c.text) ? " · listed as " : "";
    html += '<p class="meaning">' + esc(c.meaning || k.en) + '</p><p class="sub">' + (k.mine ? "In your saved words" : "In your words") + ' · ' + LV[k.lv] + ' ' + TY[k.ty] + ' · ' + stage(k) +
      (where ? where + '<span lang="ar" style="font-family:var(--ar)">' + esc(k.ar) + '</span>' + (c.partOf && c.meaning !== k.en ? ' (' + esc(k.en) + ')' : "") : "") + '</p>' +
      '<div class="row"><button class="link" data-act="translate" type="button">Translate this exact form</button></div>';
  } else if (c.state === "loading") html += '<p class="sub">Looking it up…</p>';
  else if (c.state === "offline") html += '<p class="sub">You\'re offline. Words you\'re already learning still show their meaning; new words need a connection.</p>';
  else if (c.state === "error") html += '<p class="sub">Couldn\'t translate that just now. Try again in a moment.</p><div class="row"><button class="btn small" data-act="translate" type="button">Try again</button></div>';
  else if (c.state === "limit") html += '<p class="meaning">That\'s today\'s ' + FREE_LOOKUPS + ' free lookups</p><p class="sub">Members get unlimited lookups and the whole library. Words you\'re already learning still work.</p>' +
    '<div class="row"><button class="btn primary" data-act="subscribe" type="button">Subscribe' + (CFG.priceLabel ? " · " + esc(CFG.priceLabel) : "") + '</button></div>';
  else if (c.state === "translated" || c.state === "saving" || c.state === "saved" || c.state === "save-error") {
    if (c.translation) html += '<p class="meaning">' + esc(c.translation) + '</p><p class="sub">' +
      (c.source === "ai" ? "AI meaning in this sentence" : "Machine translation" + (c.text.indexOf(" ") > -1 ? " of the phrase" : "")) + '</p>';
    else html += '<p class="sub">This word has no clear translation on its own. The whole sentence means:</p><p class="meaning" style="font-size:1rem">' + esc(c.sentenceTr) + '</p>';
    if (c.state === "saved") html += '<p class="sub" style="color:var(--known);font-weight:600">' + esc(c.savedMsg) + '</p>';
    else if (c.state === "save-error") html += '<p class="sub" style="color:var(--wrong)">' + esc(c.saveMsg) + '</p>';
    if (c.state !== "saved") {
      html += (c.editing ? '<input class="edit" id="editMeaning" value="' + esc(c.edited != null ? c.edited : c.translation) + '" aria-label="Meaning to save"' +
        (c.translation ? "" : ' placeholder="Its meaning (or leave empty and AI will add one)"') + '>' : "") +
        '<div class="row"><button class="btn primary" data-act="save" type="button"' + (c.state === "saving" ? " disabled" : "") + '>' + (c.state === "saving" ? "Saving…" : "Save word") + '</button>' +
        (c.editing ? "" : '<button class="link" data-act="edit" type="button">Edit meaning</button>') + '</div>';
    }
  }
  var count = wordEls().length;
  html += '<div class="row" style="margin-top:10px"><button class="listen" data-act="speak" type="button">Listen</button>' +
    (c.range ? '<span class="grow">' +
      // Arabic reads right to left: the next word is on the left, the previous word on the right.
      (c.range[1] < count - 1 && c.range[1] - c.range[0] < MAX_WORDS - 1 ? '<button class="listen" data-act="grow-next" type="button">← + next word</button>' : "") +
      (c.range[0] > 0 && c.range[1] - c.range[0] < MAX_WORDS - 1 ? '<button class="listen" data-act="grow-prev" type="button">+ previous word →</button>' : "") +
      '</span>' : "") + '</div>';
  pop.innerHTML = html; pop.hidden = false;
  placePop();
}
pop.addEventListener("click", function(e){
  var a = e.target.closest("[data-act]"); if (!a || !cur) return;
  var act = a.dataset.act;
  if (act === "close") return closePop();
  if (act === "translate") return translate();
  if (act === "speak") return speak(cur.text);
  if (act === "grow-next" && cur.range) return lookupRange(cur.range[0], cur.range[1] + 1);
  if (act === "grow-prev" && cur.range) return lookupRange(cur.range[0] - 1, cur.range[1]);
  if (act === "edit") { cur.editing = true; renderPop(); var i = $("#editMeaning"); if (i) i.focus(); return; }
  if (act === "subscribe") return subscribe(a);
  if (act === "save") return save();
});
pop.addEventListener("input", function(e){ if (e.target.id === "editMeaning" && cur) cur.edited = e.target.value; });
document.addEventListener("keydown", function(e){ if (e.key === "Escape") closePop(); });
// A tap or click anywhere outside the popup closes it. Swiping to scroll doesn't, and tapping another
// word just moves the popup to that word.
var outside = null;
document.addEventListener("pointerdown", function(e){
  outside = !pop.hidden && !pop.contains(e.target) && !e.target.closest("#text .w") ? {x:e.clientX, y:e.clientY, id:e.pointerId} : null;
});
document.addEventListener("pointerup", function(e){
  var o = outside; outside = null;
  if (!o || e.pointerId !== o.id || pop.hidden) return;
  if (Math.abs(e.clientX - o.x) + Math.abs(e.clientY - o.y) < 10) closePop();
});
document.addEventListener("pointercancel", function(){ outside = null; });
function save(){
  var c = cur;
  var english = (c.edited != null ? c.edited : c.translation || "").trim();
  // With no meaning for the word alone, an empty box lets the server's AI work the meaning out from the sentence.
  if (!english && c.translation) { c.state = "save-error"; c.saveMsg = "Add a meaning first."; renderPop(); return; }
  c.state = "saving"; renderPop();
  sb.functions.invoke("save-word", {body:{arabic:c.text, english:english, english_edited:!!english && c.edited != null && c.edited.trim() !== c.translation, sentence:c.sentence}}).then(function(r){
    if (r.error && r.error.context && typeof r.error.context.json === "function") return r.error.context.json().then(function(b){ return {data:b}; }, function(){ return {data:null}; });
    return r;
  }).then(function(r){
    if (c !== cur) return;
    var d = r.data;
    if (d && d.card) {
      var card = toCard(d.card);
      if (!cards.some(function(x){ return x.id === card.id; })) { cards.push(card); lsSet(ukey("cards"), cards); indexCards(); }
      c.state = "saved";
      c.savedMsg = d.already ? "Already in your saved words." : "Saved as " + LV[card.lv] + " " + TY[card.ty] + ": " + card.en + ". It will come up in your reviews.";
      refreshUnderlines();
    } else {
      c.state = "save-error";
      c.saveMsg = d && d.error === "limit" ? "You've saved today's free words. Members can save many more." : d && d.error === "already saved" ? "Already in your saved words." : "Couldn't save it: " + ((d && d.error) || "please try again.");
    }
    renderPop();
  }).catch(function(){ if (c === cur) { c.state = "save-error"; c.saveMsg = "Couldn't save it. Check you're online and try again."; renderPop(); } });
}

/* ---------- small helpers shared with the flashcards ---------- */
// Natural Arabic audio (see speech.js), with the device's own voice as a fallback.
var speaker = window.makeSpeaker({client:function(){ return sb; }, baseUrl:CFG.supabaseUrl, voice:CFG.ttsVoice, rate:CFG.ttsRate, enabled:CFG.tts !== false, onError:function(m){ toast(m); }});
function speak(text){ speaker.speak(text); }
function subscribe(btn){
  if (!CFG.paymentsEnabled) { toast("Subscriptions are opening soon."); return; }
  if (btn) btn.disabled = true;
  var back = location.origin + location.pathname.replace(/read(\.html)?$/, "");
  sb.functions.invoke("create-checkout", {body:{success_url:back + "?checkout=success", return_url:location.href}}).then(function(r){
    if (r.error || !r.data || !r.data.url) throw r.error || new Error("no url");
    location.href = r.data.url;
  }).catch(function(){ toast("Couldn't open checkout. Please try again in a minute."); if (btn) btn.disabled = false; });
}
var toastEl = null, toastTimer = null;
function toast(msg){
  if (!toastEl) { toastEl = document.createElement("div"); toastEl.setAttribute("role", "status"); toastEl.style.cssText = "position:fixed;left:50%;top:calc(14px + env(safe-area-inset-top,0px));transform:translateX(-50%);max-width:calc(100% - 32px);background:var(--ink);color:var(--paper);padding:10px 16px;border-radius:12px;font-size:.92rem;z-index:30"; document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(function(){ toastEl.hidden = true; }, 4500);
}

/* ---------- routing ---------- */
function route(){
  window.scrollTo(0, 0);
  var bm = /^#b=(.+)$/.exec(location.hash);
  if (bm) { var name = ""; try { name = decodeURIComponent(bm[1]); } catch (e) {} renderBook(name); return; }
  var m = /^#t=([\w-]+)$/.exec(location.hash);
  if (m) {
    main.innerHTML = '<div class="panel"><p>Loading the text…</p></div>';
    getText(m[1]).then(function(t){
      // Remember it for "Continue reading" on the home screen.
      var entry = libEntry(m[1]);
      if (t && m[1] !== "draft") {
        lsSet(ukey("last-text"), {id:m[1], title:entry && entry.book ? entry.book + " · " + t.title : t.title});
        if (entry && entry.book) markRead(m[1]);
      }
      renderText(t, m[1]);
    });
  } else renderHome();
}
window.addEventListener("hashchange", route);

sb.auth.getSession().then(function(r){
  var s = r.data && r.data.session;
  var stored = null;
  if (!s) { try { var ref = new URL(CFG.supabaseUrl).hostname.split(".")[0]; var t = JSON.parse(localStorage.getItem("sb-" + ref + "-auth-token")); stored = t && t.user; } catch (e) {} }
  if (!s && !(stored && !navigator.onLine)) { location.replace("./"); return; }
  user = s ? s.user : stored;
  loadCached();
  var access = CFG.readerAccess || "off";
  // Switched off: back to the flashcards. A saved non-admin role may be out of date, so that waits for the server.
  if (access === "off") { location.replace("./"); return; }
  var shown = readerAllowed();
  if (window.BA_TABS) BA_TABS.show({reader:true, admin:!!profile && (profile.role === "admin" || profile.role === "editor")});
  if (!shown) main.innerHTML = '<div class="panel"><p>Loading…</p></div>';
  var idx = lsGet(ukey("read-index"));
  if (idx) { library = idx.library || []; readable = new Set(idx.readable || []); mine = idx.mine || []; }
  readDone = lsGet(ukey("read-done")) || {};
  if (shown) route();
  loadRemote().then(function(){
    if (!readerAllowed()) { location.replace("./"); return; }
    if (!shown) route();
    else if (/^#b=/.test(location.hash)) route();
    else if (!/^#t=/.test(location.hash)) renderHome(); else {
      // A chapter opened before the library list had loaded: show it again with its book and chapter buttons.
      var nav = document.querySelector(".chnav"), m = /^#t=([\w-]+)$/.exec(location.hash), entry = m && libEntry(m[1]);
      if (entry && entry.book && !nav) route();
      else { refreshUnderlines(); if (nav && m) nav.outerHTML = chapterNav(m[1]); }
    }
  }).catch(function(err){ console.warn(err); if (!idx) main.innerHTML = '<div class="panel"><p>Couldn\'t load. Check your connection and reload.</p></div>'; });
});
})();
