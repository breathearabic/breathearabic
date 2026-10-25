/* Breathe Arabic: matching Arabic words in a text to the learner's words (deck cards and saved words), and
   how well each is known. Shared by the Read page and the Learn page, so both underline words the same way.
   makeWordMatcher(getCards, getProg, knownDays): getCards() returns cards {id, ar, en, so, mine}, getProg() returns
   card id -> FSRS state {st, s}. Call index() after the cards change. */
window.makeWordMatcher = function(getCards, getProg, knownDays){
  "use strict";
  var byKey = new Map();
  var LETTER = "ء-غف-يً-ٰٟٱ-ۓـ";
  var WORD_RE = new RegExp("[" + LETTER + "]+|[^" + LETTER + "]+", "g");
  var IS_WORD = new RegExp("^[" + LETTER + "]+$");
  function normKey(s){
    return String(s).replace(/[ً-ٰٟـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
      .replace(new RegExp("[^ء-ي\\s]", "g"), " ").replace(/\s+/g, " ").trim();
  }
  var PREFIXES = ["وبال", "وكال", "وال", "فال", "بال", "كال", "لل", "ال", "و", "ف", "ب", "ل", "ك", "س"];
  var SUFFIXES = ["هما", "كما", "تما", "هم", "هن", "كم", "كن", "نا", "ها", "ات", "ون", "ين", "ان", "تم", "وا", "ه", "ك", "ي", "ت"];
  function candidates(k){
    var out = [k], seen = {}; seen[k] = 1;
    function add(x){ if (x.length >= 2 && !seen[x]) { seen[x] = 1; out.push(x); } }
    var stems = [k];
    PREFIXES.forEach(function(p){ if (k.indexOf(p) === 0 && k.length - p.length >= 2) stems.push(k.slice(p.length)); });
    stems.slice().forEach(function(s){ SUFFIXES.forEach(function(x){ if (s.length - x.length >= 2 && s.slice(-x.length) === x) stems.push(s.slice(0, -x.length)); }); });
    // A ta marbuta becomes ت before a suffix (مدرستي → مدرسة).
    stems.slice().forEach(function(s){ if (/ت$/.test(s)) stems.push(s.slice(0, -1) + "ه"); });
    stems.forEach(function(s){ add(s); add("ال" + s); if (s.indexOf("ال") === 0) add(s.slice(2)); add(s + "ه"); });
    return out;
  }
  /* Some deck cards hold several words: opposites ("التالي × السابق" = "next × previous"), pairs of different
     words ("الشعر - الخطابة" = "poetry, oratory"), or forms of one word ("قطار ج قطارات" = "train (pl. trains)").
     Each word is matched on its own. When the English splits into the same number of parts, the popup shows
     only that word's part ("next"); otherwise the card's full meaning, which covers all its forms. */
  var AR_MAIN_SPLIT = /\s*(?:[\/،,×=]|\s-\s?|-\s|–|-)\s*|\sج\s|\sم\s|\sالمفرد\s|\sالجمع\s/;
  function splitTop(s, seps){
    var out = [], buf = "", depth = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === "(" || ch === "[") depth++;
      else if ((ch === ")" || ch === "]") && depth) depth--;
      if (!depth && seps.indexOf(ch) > -1) { out.push(buf); buf = ""; } else buf += ch;
    }
    out.push(buf);
    return out.map(function(x){ return x.trim(); }).filter(Boolean);
  }
  function englishParts(c){
    var seps = c.ar.indexOf("×") > -1 ? "×" : c.ar.indexOf("/") > -1 ? "/" : ",;";
    return splitTop(String(c.en), seps);
  }
  function indexCards(){
    byKey = new Map();
    function add(key, entry){
      if (!key) return;
      var l = byKey.get(key) || [];
      if (!l.some(function(e){ return e.card === entry.card; })) l.push(entry);
      byKey.set(key, l);
    }
    getCards().forEach(function(c){
      add(normKey(c.ar), {card:c, en:c.en, full:true});
      // Words outside brackets, which can line up with the English parts.
      var main = String(c.ar).replace(/\([^)]*\)|\[[^\]]*\]/g, " ").split(AR_MAIN_SPLIT).map(normKey).filter(Boolean);
      var en = englishParts(c), aligned = main.length > 1 && en.length === main.length;
      if (main.length > 1) main.forEach(function(p, i){ add(p, {card:c, en:aligned ? en[i] : c.en, full:false, aligned:aligned}); });
      // A word with a bracketed note ("العَذْب (ماء)") matches without the note. The note itself doesn't
      // match this card: tapping ماء shouldn't show "fresh, sweet (water)".
      else if (main.length === 1 && main[0] !== normKey(c.ar)) add(main[0], {card:c, en:c.en, full:true});
    });
  }
  function bestOf(list){
    // Prefer an exact whole-card match, then the learner's saved word, then a studied card, then deck order.
    return list.slice().sort(function(a, b){
      return (b.full - a.full) || (b.card.mine - a.card.mine) || ((getProg()[b.card.id] ? 1 : 0) - (getProg()[a.card.id] ? 1 : 0)) || (a.card.so - b.card.so);
    })[0];
  }
  function match(text){
    var k = normKey(text);
    if (!k) return null;
    if (byKey.has(k)) return bestOf(byKey.get(k));
    if (k.indexOf(" ") > -1) return null;
    var c = candidates(k);
    for (var i = 1; i < c.length; i++) if (byKey.has(c[i])) return bestOf(byKey.get(c[i]));
    return null;
  }
  // Same stages as the flashcards: known once its memory lasts KNOWN_DAYS (21 by default).
  var KNOWN_DAYS = knownDays || 21;
  function stage(card){
    var s = getProg()[card.id];
    if (!s) return card.mine ? "saved, not studied yet" : "not studied yet";
    if (s.st !== 2) return "learning";
    return s.s >= 90 ? "mastered" : s.s >= KNOWN_DAYS ? "known" : "young";
  }
  function cls(card){
    if (!card) return "";
    var s = getProg()[card.id];
    if (s) return s.st !== 2 ? "k1" : s.s >= KNOWN_DAYS ? "k2" : "ky";
    return card.mine ? "k0" : "";
  }
  return {LETTER:LETTER, WORD_RE:WORD_RE, IS_WORD:IS_WORD, KNOWN_DAYS:KNOWN_DAYS, normKey:normKey, candidates:candidates,
    index:indexCards, match:match, stage:stage, cls:cls};
};
