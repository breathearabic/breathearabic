/* Breathe Arabic: the Learn tab. Short lessons by level (A1–C2), grouped into units: read a short story
   (with audio and an English translation), learn its key words, then answer comprehension questions.
   Lessons are written by editors on the admin page (table "lessons", 015_lessons.sql). */
(function(){
"use strict";
var CFG = window.ARVOCAB_CONFIG || {};
var LV = ["", "A1", "A2", "B1", "B2", "C1", "C2"];
var LV_NAME = ["", "Beginner", "Elementary", "Intermediate", "Upper intermediate", "Advanced", "Proficient"];
var TY = {n:"noun", v:"verb", a:"adjective", d:"adverb", p:"phrase", r:"particle"};
var $ = function(s){ return document.querySelector(s); };
var main = $("#main");

function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(ch){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]; }); }
function lsGet(k){ try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function check(q){ return q.then(function(r){ if (r.error) throw r.error; return r; }); }

if (!CFG.supabaseUrl || !CFG.supabaseKey || !window.supabase) { main.innerHTML = '<div class="panel"><p>This copy of the app isn\'t connected yet.</p></div>'; return; }
var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
var user = null, member = null, profile = null;
var index = [], done = {}, lessons = {};   // lesson list, lesson id -> {score,total}, lesson id -> full lesson
var cards = [], prog = {};                 // the learner's words and how well they know them, for the underlines
var W = window.makeWordMatcher(function(){ return cards; }, function(){ return prog; }, +CFG.knownDays || 21);
function ukey(k){ return "arvocab-u:" + user.id + ":" + k; }

/* ---------- membership (same rules as the flashcards) ---------- */
function hasAccess(){
  if (profile && (profile.role === "admin" || profile.role === "editor")) return true;
  var m = member; if (!m) return false;
  var end = m.current_period_end ? Date.parse(m.current_period_end) : null, now = Date.now();
  if ((m.status === "active" || m.status === "comp") && (end == null || end > now)) return true;
  return (m.status === "canceled" || m.status === "past_due") && end != null && end > now;
}
function readerAllowed(){
  var access = CFG.readerAccess || "off";
  return access === "everyone" || (access === "admin" && !!profile && profile.role === "admin");
}
function canOpen(l){ return l.is_free || hasAccess(); }
// Admins and editors get an Edit lesson button that opens the lesson in the admin page's editor.
function canEdit(){ return !!profile && (profile.role === "admin" || profile.role === "editor"); }

/* ---------- matching story words to key words (ignores vowels, و/ف/ب/ل and ال at the front) ---------- */
function bare(s){
  return String(s).replace(/[ً-ٰٟـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[^ء-ي]/g, "");
}
function forms(word){
  var b = bare(word), out = [b];
  ["و", "ف"].forEach(function(p){ if (b.indexOf(p) === 0 && b.length > 3) out.push(b.slice(1)); });
  out.slice().forEach(function(x){ ["بال", "لل", "ال", "ب", "ل"].forEach(function(p){ if (x.indexOf(p) === 0 && x.length - p.length >= 2) out.push(x.slice(p.length)); }); });
  return out;
}
function kwIndexFor(token, kws){
  var f = forms(token);
  for (var i = 0; i < kws.length; i++) {
    var k = bare(kws[i].ar), k2 = k.indexOf("ال") === 0 ? k.slice(2) : k;
    if (f.indexOf(k) > -1 || f.indexOf(k2) > -1) return i;
  }
  return -1;
}

/* ---------- loading ---------- */
function toCard(r){ return {id:r.id, ar:r.arabic, en:r.english, lv:r.level, ty:r.word_type, so:r.sort_order, mine:/^u-/.test(r.id)}; }
function fetchAll(table, cols, order){
  var out = [];
  function page(from){
    return check(sb.from(table).select(cols).order(order, {ascending:true}).range(from, from + 999)).then(function(r){
      out = out.concat(r.data || []);
      return r.data && r.data.length === 1000 ? page(from + 1000) : out;
    });
  }
  return page(0);
}
function loadCached(){
  cards = (lsGet(ukey("cards")) || []).map(function(c){ c.mine = /^u-/.test(c.id); return c; });
  prog = lsGet(ukey("prog")) || {};
  W.index();
  index = lsGet(ukey("lesson-index")) || [];
  done = lsGet(ukey("lesson-done")) || {};
  member = lsGet(ukey("member")); profile = lsGet(ukey("profile"));
}
function loadRemote(){
  return Promise.all([
    check(sb.from("memberships").select("*").eq("user_id", user.id).maybeSingle()),
    check(sb.from("profiles").select("id,email,role").eq("id", user.id).maybeSingle()),
    check(sb.rpc("lesson_index")),
    check(sb.from("lesson_progress").select("lesson_id,score,total"))
  ]).then(function(r){
    member = r[0].data || null; profile = r[1].data || null;
    index = r[2].data || [];
    done = {}; (r[3].data || []).forEach(function(p){ done[p.lesson_id] = {score:p.score, total:p.total}; });
    lsSet(ukey("member"), member); lsSet(ukey("profile"), profile);
    lsSet(ukey("lesson-index"), index); lsSet(ukey("lesson-done"), done);
  });
}
// The learner's words, for underlining by how well each is known (like the Read page). The word list is the one
// the flashcards and Read page already keep on the device; it's only fetched here when there isn't one yet.
function loadWords(){
  return Promise.all([
    cards.length ? null : fetchAll("cards", "id,level,word_type,arabic,english,sort_order,is_active", "sort_order"),
    fetchAll("progress", "card_id,state", "card_id")
  ]).then(function(r){
    if (r[0]) { cards = r[0].filter(function(c){ return c.is_active !== false; }).map(toCard); lsSet(ukey("cards"), cards); }
    var local = lsGet(ukey("prog")) || {};   // answers the flashcards haven't sent yet
    prog = {}; r[1].forEach(function(x){ prog[x.card_id] = x.state; });
    Object.keys(local).forEach(function(id){ prog[id] = local[id]; });
    W.index(); refreshUnderlines();
  }).catch(function(err){ console.warn(err); });
}
function refreshUnderlines(){
  document.querySelectorAll(".story .w").forEach(function(el){
    var hit = W.match(el.dataset.w);
    el.className = "w " + W.cls(hit && hit.card) + (el.classList.contains("sel") ? " sel" : "");
  });
}
// The saved copy shows straight away; the server's copy replaces it (and redraws the story) if an editor changed it.
function getLesson(id){
  if (lessons[id]) return Promise.resolve(lessons[id]);
  var cached = lsGet(ukey("lesson:" + id));
  var fresh = check(sb.from("lessons").select("*").eq("id", id).maybeSingle()).then(function(r){
    if (r.data) {
      // Compare the whole lesson, not just updated_at: a change made straight in the database may not touch it.
      var changed = !cached || JSON.stringify(cached) !== JSON.stringify(r.data);
      lessons[id] = r.data; lsSet(ukey("lesson:" + id), r.data);
      if (cached && changed && cur && cur.id === id && !quiz) renderLesson(r.data);
    }
    return r.data;
  });
  if (!cached) return fresh;
  fresh.catch(function(){});   // offline: keep the saved copy
  return Promise.resolve(lessons[id] = cached);
}

/* ---------- the lesson list ---------- */
function nextLesson(){
  return index.filter(function(l){ return !done[l.id] && canOpen(l); })[0] || null;
}
function chosenLevel(){
  var saved = lsGet(ukey("learn-level"));
  if (saved && index.some(function(l){ return l.level === saved; })) return saved;
  var n = nextLesson();
  return n ? n.level : (index[0] ? index[0].level : 1);
}
function renderList(){
  if (!index.length) { main.innerHTML = '<div class="panel empty"><p>Lessons are on their way. Check back soon.</p></div>'; return; }
  var lv = chosenLevel(), next = nextLesson();
  var tabs = '<div class="levels" role="tablist" aria-label="Level">' + [1,2,3,4,5,6].map(function(l){
    var has = index.some(function(x){ return x.level === l; });
    return '<button type="button" role="tab" data-lv="' + l + '" aria-selected="' + (l === lv) + '"' + (has ? "" : " disabled") + '>' + LV[l] + '</button>';
  }).join("") + '</div>';
  var mine = index.filter(function(l){ return l.level === lv; });
  var finished = mine.filter(function(l){ return done[l.id]; }).length;
  var html = tabs + '<div class="lvprog" style="--lvc:var(--lv' + lv + ')"><span>' + LV[lv] + ' ' + LV_NAME[lv] + ' · ' + finished + ' of ' + mine.length + ' lesson' + (mine.length === 1 ? "" : "s") + ' done</span>' +
    '<span class="bar"><i style="width:' + (mine.length ? Math.round(finished / mine.length * 100) : 0) + '%"></i></span></div>';
  var units = [];
  mine.forEach(function(l){ var u = units[units.length - 1]; if (!u || u.unit !== l.unit) units.push(u = {unit:l.unit, title:l.unit_title, items:[]}); u.items.push(l); });
  units.forEach(function(u){
    html += '<section class="unit"><h2>Unit ' + u.unit + (u.title ? ' · ' + esc(u.title) : "") + '</h2><div class="lessons">';
    u.items.forEach(function(l){
      var d = done[l.id], locked = !canOpen(l), isNext = next && next.id === l.id;
      var cls = d ? "done" : locked ? "locked" : isNext ? "next" : "";
      var meta = locked ? "For members: join from the home screen" : d ? d.score + " of " + d.total + " right" : l.words + " key word" + (l.words === 1 ? "" : "s") + " · " + l.questions + " question" + (l.questions === 1 ? "" : "s") + (isNext ? " · next" : "");
      html += '<a class="lesson-row ' + cls + '" href="' + (locked ? "./" : "#l=" + l.id) + '">' +
        '<span class="dot" aria-hidden="true">' + (d ? "✓" : locked ? "–" : l.position) + '</span>' +
        '<span class="t"><b>' + esc(l.title_en) + '</b><small>' + esc(meta) + '</small></span>' +
        '<span class="ar">' + esc(l.title_ar) + '</span></a>';
    });
    html += '</div></section>';
  });
  main.innerHTML = html;
}
main.addEventListener("click", function(e){
  var b = e.target.closest("[data-lv]");
  if (b && !b.disabled) { lsSet(ukey("learn-level"), +b.dataset.lv); renderList(); }
});

/* ---------- a lesson: story, audio, key words ---------- */
var speaker = window.makeSpeaker ? window.makeSpeaker({client:function(){ return sb; }, baseUrl:CFG.supabaseUrl, voice:CFG.ttsVoice, rate:CFG.ttsRate, enabled:CFG.tts !== false, onError:function(m){ toast(m); }}) : null;
var cur = null;   // the lesson on screen
function head(l, step){
  var meta = index.filter(function(x){ return x.id === l.id; })[0] || l;
  return '<div class="lhead"><a class="back" href="#" aria-label="Back to lessons"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg></a>' +
    '<span class="steps" aria-label="Step ' + step + ' of 2"><i class="on"></i><i' + (step > 1 ? ' class="on"' : "") + '></i></span>' +
    (canEdit() ? '<a class="iconbtn" href="admin.html#lesson=' + encodeURIComponent(l.id) + '" style="text-decoration:none">Edit lesson</a>' : "") + '</div>' +
    '<div class="ltitle"><small>' + LV[l.level] + ' · Unit ' + l.unit + ' · Lesson ' + meta.position + '</small><h1>' + esc(l.title_ar) + '</h1><p>' + esc(l.title_en) + '</p></div>';
}
// Every word is tappable, and underlined by how well the learner knows it (same colours as the Read page).
function storyHtml(l){
  var kws = l.key_words || [];
  return (l.lines || []).map(function(line){
    return String(line.ar || "").split(/(\s+)/).map(function(tok){
      if (!/\S/.test(tok)) return tok;
      var word = tok.replace(/[.,،؛:!؟?«»"()]+/g, "");
      if (!word) return esc(tok);
      var i = kwIndexFor(word, kws), pre = tok.slice(0, tok.indexOf(word)), post = tok.slice(tok.indexOf(word) + word.length);
      var hit = W.match(word);
      return esc(pre) + '<span class="w ' + W.cls(hit && hit.card) + '" data-w="' + esc(word) + '"' + (i > -1 ? ' data-kw="' + i + '"' : "") + ' tabindex="0" role="button">' + esc(word) + '</span>' + esc(post);
    }).join("");
  }).join(isDialogue(l) ? "<br>" : " ");
}
// A dialogue: every sentence starts with the speaker's name and a colon ("خَلِيلٌ: …"). Each speaker then gets a new line.
function isDialogue(l){ var ls = l.lines || []; return ls.length > 1 && ls.every(function(x){ return /^[^\s:]+:\s/.test(String(x.ar || "")); }); }
// A word's meaning in this story: as written, or the same word with different vowels.
function glossOf(l, w){
  var g = l.glosses || {};
  if (g[w]) return g[w];
  var b = bare(w), k = Object.keys(g).filter(function(x){ return bare(x) === b; })[0];
  return k ? g[k] : "";
}
function storyText(l){ return (l.lines || []).map(function(x){ return x.ar; }).join(" "); }
function renderLesson(l){
  cur = l;
  var showEn = lsGet("arvocab-learn-show-en") === true;
  var kws = l.key_words || [];
  var html = head(l, 1) +
    '<div class="player"><button class="play" type="button" data-act="play" aria-label="Listen to the story"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z"></path></svg></button>' +
    '<span class="grow">Listen to the story</span></div>' +
    '<div class="story"><span class="ar" lang="ar">' + storyHtml(l) + '</span>' +
    '<button class="link" type="button" data-act="toggle-en" aria-expanded="' + showEn + '" style="margin-top:10px">' + (showEn ? "Hide translation" : "Show translation") + '</button>' +
    '<div class="en"' + (showEn ? "" : " hidden") + '>' + (l.lines || []).map(function(x){ return esc(x.en); }).join(isDialogue(l) ? "<br>" : " ") + '</div>' +
    '<div class="legend"><span><i style="border-color:var(--known)"></i>Known</span><span><i style="border-color:color-mix(in srgb,var(--known) 50%,transparent)"></i>Young</span><span><i style="border-color:var(--learning)"></i>Learning</span><span><i style="border-color:var(--lapis)"></i>Saved</span><span>Tap any word for its meaning.</span></div></div>';
  if (kws.length) {
    html += '<div class="sec-head"><h2>Key words</h2><button class="link" type="button" data-act="add-all">Add all to flashcards</button></div><div class="words">' +
      kws.map(function(k, i){
        return '<div class="word"><span class="t"><b>' + esc(k.en) + '</b><small>' + esc((TY[k.type] || "") + (k.level ? " · " + LV[k.level] : "")) + '</small></span>' +
          '<span class="ar" lang="ar">' + esc(k.ar) + '</span>' +
          '<button class="iconbtn" type="button" data-act="say" data-kw="' + i + '" aria-label="Listen to ' + esc(k.en) + '"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H3v6h3l5 4z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path></svg></button>' +
          addBtn(k, i) + '</div>';
      }).join("") + '</div>';
  }
  var qn = (l.questions || []).length;
  html += qn ? '<a class="cta" href="#l=' + l.id + '/q">Answer ' + qn + ' question' + (qn === 1 ? "" : "s") + '</a>' : '<a class="cta" href="#">Back to lessons</a>';
  main.innerHTML = html;
  window.scrollTo(0, 0);
}

/* Adding key words to the flashcards: they become the learner's own cards (like words saved on the Read page),
   with the story sentence as the example. Words already in the deck are left to the deck. */
function deckCards(){ return lsGet(ukey("cards")) || []; }
function inDeck(k){ var b = bare(k.ar); return deckCards().some(function(c){ return !c.mine && !/^u-/.test(c.id) && bare(c.ar) === b; }); }
function savedAlready(k){ var b = bare(k.ar); return deckCards().some(function(c){ return /^u-/.test(c.id) && bare(c.ar) === b; }) || !!(lsGet(ukey("lesson-added")) || {})[b]; }
function addBtn(k, i){
  if (inDeck(k)) return '<span class="iconbtn ok" title="Already in your flashcards deck">In deck</span>';
  if (savedAlready(k)) return '<span class="iconbtn ok">Added</span>';
  return '<button class="iconbtn" type="button" data-act="add" data-kw="' + i + '" aria-label="Add ' + esc(k.en) + ' to flashcards"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg></button>';
}
function exampleFor(l, k){
  var line = (l.lines || []).filter(function(x){ return String(x.ar).split(/\s+/).some(function(t){ return kwIndexFor(t.replace(/[.،؛:!؟?]+/g, ""), [k]) === 0; }); })[0];
  return line ? [[line.ar, line.en || ""]] : [];
}
function addWord(l, i){
  var k = l.key_words[i];
  if (inDeck(k) || savedAlready(k)) return Promise.resolve();
  var row = {id:"u-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + i), owner_id:user.id, level:k.level || l.level, word_type:k.type || "n",
    arabic:k.ar, english:k.en, examples:exampleFor(l, k), sort_order:-900000000 + Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 1000) + i, is_free:true};
  return sb.from("cards").insert(row).then(function(r){
    if (r.error && r.error.code !== "23505") throw r.error;   // 23505: already saved
    var added = lsGet(ukey("lesson-added")) || {}; added[bare(k.ar)] = 1; lsSet(ukey("lesson-added"), added);
    if (!r.error) { cards.push(toCard(row)); lsSet(ukey("cards"), cards); W.index(); refreshUnderlines(); }
  });
}
function refreshWords(){
  if (!cur) return;
  document.querySelectorAll(".word").forEach(function(row, i){
    var old = row.querySelector("[data-act=add], .iconbtn.ok");
    if (old) old.outerHTML = addBtn(cur.key_words[i], i);
  });
}

/* ---------- a word's meaning, when tapped in the story ---------- */
var wpop = null;
function closeWpop(){ if (wpop) { wpop.remove(); wpop = null; } document.querySelectorAll(".story .w.sel").forEach(function(x){ x.classList.remove("sel"); }); }
function openWpop(el){
  closeWpop();
  var w = el.dataset.w, k = el.dataset.kw != null ? cur.key_words[+el.dataset.kw] : null;
  // The lesson's own meaning first; failing that, the key word's or the matching flashcard's meaning.
  var hit = W.match(w), meaning = glossOf(cur, w) || (k ? k.en : "") || (hit ? hit.en || hit.card.en : "");
  var known = hit ? (hit.card.mine ? "In your saved words" : "In your words") + " · " + W.stage(hit.card) : "";
  el.classList.add("sel");
  wpop = document.createElement("div"); wpop.className = "wpop"; wpop.setAttribute("role", "dialog");
  wpop.innerHTML = '<span class="ar" lang="ar">' + esc(w) + '</span><span style="display:grid"><b>' + esc(meaning || "Meaning coming soon") + '</b>' +
    (k && bare(k.ar) !== bare(w) ? '<small style="color:var(--muted)">Key word: <span lang="ar" style="font-family:var(--ar);font-size:1.1rem">' + esc(k.ar) + '</span> ' + esc(k.en) + '</small>' : k ? '<small style="color:var(--muted)">Key word</small>' : "") +
    (known ? '<small style="color:var(--muted)">' + esc(known) + '</small>' : "") +
    '</span><button class="iconbtn" type="button" data-act="say-pop">Listen</button>';
  document.body.appendChild(wpop);
  var r = el.getBoundingClientRect(), w = wpop.offsetWidth;
  wpop.style.top = (window.scrollY + r.bottom + 8) + "px";
  wpop.style.left = Math.max(10, Math.min(window.scrollX + r.left + r.width / 2 - w / 2, document.documentElement.clientWidth - w - 10)) + "px";
  wpop.querySelector("button").addEventListener("click", function(){ say(w); });
}
function say(text){ if (speaker) speaker.speak(text); }
document.addEventListener("click", function(e){
  if (wpop && !e.target.closest(".wpop") && !e.target.closest(".story .w")) closeWpop();
});
main.addEventListener("keydown", function(e){
  var w = e.target.closest && e.target.closest(".story .w");
  if (w && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openWpop(w); }
  if (e.key === "Escape") closeWpop();
});

main.addEventListener("click", function(e){
  var tapped = e.target.closest(".story .w");
  if (tapped) { openWpop(tapped); return; }
  var b = e.target.closest("[data-act]"); if (!b || !cur) return;
  var act = b.dataset.act;
  if (act === "play") {
    // The audio service takes up to 400 characters at once: play as many whole sentences as fit.
    var text = "";
    (cur.lines || []).some(function(x){ if ((text + " " + x.ar).length > 400) return true; text = (text + " " + x.ar).trim(); return false; });
    say(text || storyText(cur).slice(0, 400));
  }
  if (act === "say") say(cur.key_words[+b.dataset.kw].ar);
  if (act === "toggle-en") {
    var en = main.querySelector(".story .en"), show = en.hidden;
    en.hidden = !show; b.textContent = show ? "Hide translation" : "Show translation"; b.setAttribute("aria-expanded", String(show));
    lsSet("arvocab-learn-show-en", show);
  }
  if (act === "add" || act === "add-all") {
    var l = cur, which = act === "add" ? [+b.dataset.kw] : l.key_words.map(function(_, i){ return i; });
    b.disabled = true;
    which.reduce(function(p, i){ return p.then(function(){ return addWord(l, i); }); }, Promise.resolve())
      .then(function(){ refreshWords(); toast(which.length === 1 ? "Added to your flashcards." : "Key words added to your flashcards."); })
      .catch(function(err){ b.disabled = false; toast("Couldn't add: " + (err.message || err)); });
  }
});

/* ---------- comprehension questions ---------- */
var quiz = null;   // {lesson, i, picked, score, order}
// Answers are shown in a random order (fixed for each attempt), so the right one isn't always in the same place.
// True/false keeps its natural order.
function answerOrder(q){
  var n = (q.options || []).length, idx = [];
  for (var i = 0; i < n; i++) idx.push(i);
  if (n === 2 && /^صَحِيحٌ$/.test(q.options[0].ar) && /^خَطَأٌ$/.test(q.options[1].ar)) return idx;
  for (var j = n - 1; j > 0; j--) { var r = Math.floor(Math.random() * (j + 1)), t = idx[j]; idx[j] = idx[r]; idx[r] = t; }
  return idx;
}
function renderQuestion(){
  var l = quiz.lesson, qs = l.questions || [], q = qs[quiz.i], answered = quiz.picked != null;
  quiz.order = quiz.order || {};
  var order = quiz.order[quiz.i] || (quiz.order[quiz.i] = answerOrder(q));
  var html = head(l, 2) + '<p class="q-num">Question ' + (quiz.i + 1) + ' of ' + qs.length + '</p>' +
    '<p class="q-ar" lang="ar">' + esc(q.ar) + '</p>' + (q.en ? '<p class="q-en">' + esc(q.en) + '</p>' : "") +
    '<div class="opts">' + order.map(function(k){
      var o = q.options[k];
      var c = answered ? (k === q.right ? " right" : k === quiz.picked ? " wrong" : "") : "";
      return '<button class="opt' + c + '" type="button" data-pick="' + k + '"' + (answered ? " disabled" : "") + '><span class="en">' + esc(o.en || "") + '</span><span class="ar" lang="ar">' + esc(o.ar) + '</span></button>';
    }).join("") + '</div>';
  if (answered) {
    var ok = quiz.picked === q.right;
    html += '<div class="fb' + (ok ? " good" : "") + '" role="status"><b>' + (ok ? "Correct" : "Not quite") + '</b>' + (q.why ? esc(q.why) : "") +
      (q.line ? '<span class="ar" lang="ar">' + esc(q.line) + '</span>' : "") + '</div>' +
      '<button class="cta" type="button" data-act="next-q">' + (quiz.i < qs.length - 1 ? "Next question" : "See my score") + '</button>';
  }
  main.innerHTML = html;
}
function renderResult(){
  var l = quiz.lesson, total = (l.questions || []).length, next = nextLesson();
  main.innerHTML = '<div class="result"><div class="score">' + quiz.score + ' / ' + total + '</div><h2>Lesson complete</h2>' +
    '<p>' + (quiz.score === total ? "All right. Well done." : "Look back at the story to see the answers you missed.") + ' Add the key words to your flashcards so they come back for review.</p>' +
    (next ? '<a class="cta" href="#l=' + next.id + '">Next lesson: ' + esc(next.title_en) + '</a>' : '<a class="cta" href="#">Back to lessons</a>') +
    '<a class="cta ghost" href="#l=' + l.id + '">Back to the story</a>' +
    '<button class="cta ghost" type="button" data-act="again">Try the questions again</button></div>';
}
main.addEventListener("click", function(e){
  if (!quiz) return;
  var p = e.target.closest("[data-pick]");
  if (p && quiz.picked == null) {
    quiz.picked = +p.dataset.pick;
    if (quiz.picked === quiz.lesson.questions[quiz.i].right) quiz.score++;
    renderQuestion(); return;
  }
  var b = e.target.closest("[data-act]"); if (!b) return;
  if (b.dataset.act === "next-q") {
    if (quiz.i < quiz.lesson.questions.length - 1) { quiz.i++; quiz.picked = null; renderQuestion(); window.scrollTo(0, 0); }
    else finish();
  }
  if (b.dataset.act === "again") { quiz = {lesson:quiz.lesson, i:0, picked:null, score:0}; renderQuestion(); }
});
function finish(){
  var l = quiz.lesson, total = l.questions.length;
  var best = done[l.id] && done[l.id].score > quiz.score ? done[l.id].score : quiz.score;   // keep the best score
  done[l.id] = {score:best, total:total}; lsSet(ukey("lesson-done"), done);
  sb.from("lesson_progress").upsert({user_id:user.id, lesson_id:l.id, score:best, total:total, completed_at:new Date().toISOString()}, {onConflict:"user_id,lesson_id"})
    .then(function(r){ if (r.error) console.warn(r.error); });
  renderResult();
}

/* ---------- small helpers ---------- */
var toastEl = null, toastTimer = null;
function toast(msg){
  if (!toastEl) { toastEl = document.createElement("div"); toastEl.setAttribute("role", "status"); toastEl.style.cssText = "position:fixed;left:50%;top:calc(14px + env(safe-area-inset-top,0px));transform:translateX(-50%);max-width:calc(100% - 32px);background:var(--ink);color:var(--paper);padding:10px 16px;border-radius:12px;font-size:.92rem;z-index:30"; document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(function(){ toastEl.hidden = true; }, 3200);
}

/* ---------- routes: "" the list, "#l=<id>" a lesson, "#l=<id>/q" its questions ---------- */
function route(){
  closeWpop(); quiz = null;
  var m = /^#l=([\w-]+)(\/q)?$/.exec(location.hash);
  if (!m) { cur = null; renderList(); return; }
  var meta = index.filter(function(x){ return x.id === m[1]; })[0];
  if (meta && !canOpen(meta)) { location.hash = ""; return; }
  main.innerHTML = '<div class="panel"><p>Loading…</p></div>';
  getLesson(m[1]).then(function(l){
    if (!l) { main.innerHTML = '<div class="panel"><p>That lesson isn\'t available.</p><p><a href="#">Back to lessons</a></p></div>'; return; }
    if (m[2] && (l.questions || []).length) { cur = l; quiz = {lesson:l, i:0, picked:null, score:0}; renderQuestion(); window.scrollTo(0, 0); }
    else renderLesson(l);
  }).catch(function(){ main.innerHTML = '<div class="panel"><p>Couldn\'t load the lesson. Check your connection and try again.</p></div>'; });
}
window.addEventListener("hashchange", route);

sb.auth.getSession().then(function(r){
  var s = r.data && r.data.session, stored = null;
  if (!s) { try { var ref = new URL(CFG.supabaseUrl).hostname.split(".")[0]; var t = JSON.parse(localStorage.getItem("sb-" + ref + "-auth-token")); stored = t && t.user; } catch (e) {} }
  if (!s && !(stored && !navigator.onLine)) { location.replace("./"); return; }
  user = s ? s.user : stored;
  loadCached();
  if (window.BA_TABS) BA_TABS.show({reader:readerAllowed()});
  if (index.length) route();
  loadWords();
  loadRemote().then(function(){
    if (window.BA_TABS) BA_TABS.show({reader:readerAllowed()});
    if (!/^#l=/.test(location.hash)) renderList(); else if (!cur && !quiz) route();
  }).catch(function(err){ console.warn(err); if (!index.length) main.innerHTML = '<div class="panel"><p>Couldn\'t load lessons. Check your connection and reload.</p></div>'; });
});
})();
