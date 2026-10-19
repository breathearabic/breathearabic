/* Breathe Arabic: the Listen buttons, shared by the flashcards and the Read page.
   Plays natural Arabic audio from the "speak" server function (Google Text-to-Speech, made once per word
   or sentence and saved for everyone). Each clip's address is remembered on the device, so replays are
   instant and work offline once played. If there's no connection, or the function isn't set up,
   it falls back to the device's own Arabic voice when it has one. */
window.makeSpeaker = function(opts){
  "use strict";
  var URLS_KEY = "arvocab-tts-urls", MAX_URLS = 1500;
  var SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
  var urls = {};
  try { urls = JSON.parse(localStorage.getItem(URLS_KEY)) || {}; } catch (e) {}
  var player = new Audio();
  player.preload = "auto";
  var arVoice = null, ticket = 0;
  var onError = opts.onError || function(){};

  function pickVoice(){
    if (!("speechSynthesis" in window)) return;
    arVoice = window.speechSynthesis.getVoices().filter(function(v){ return /^ar/i.test(v.lang); })[0] || null;
  }
  pickVoice();
  if ("speechSynthesis" in window) window.speechSynthesis.addEventListener("voiceschanged", pickVoice);

  function deviceSpeak(text){
    if (!arVoice) return false;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.voice = arVoice; u.lang = arVoice.lang; u.rate = 0.85;
      window.speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }
  function remember(text, url){
    urls[text] = url;
    var keys = Object.keys(urls);
    if (keys.length > MAX_URLS) delete urls[keys[0]];
    try { localStorage.setItem(URLS_KEY, JSON.stringify(urls)); } catch (e) {}
  }
  // Clips are kept in the browser's cache storage, so a word heard once plays instantly and offline.
  var AUDIO_CACHE = "arvocab-audio", blobs = {};
  function load(url){
    if (blobs[url]) return Promise.resolve(blobs[url]);
    if (!("caches" in window)) return Promise.resolve(url);
    return caches.open(AUDIO_CACHE).then(function(cache){
      return cache.match(url).then(function(hit){
        return hit || fetch(url).then(function(res){ if (res.ok) cache.put(url, res.clone()); return res; });
      });
    }).then(function(res){
      if (!res.ok) throw new Error("audio " + res.status);
      return res.blob();
    }).then(function(b){ blobs[url] = URL.createObjectURL(b); return blobs[url]; })
      .catch(function(){ return url; });
  }
  function unlock(){
    // iPhones only allow sound that starts during the tap itself, so start a silent clip now
    // and swap in the real audio when it's ready.
    player.pause(); player.src = SILENT;
    var p = player.play(); if (p && p.catch) p.catch(function(){});
  }
  function play(url, text, mine){
    load(url).then(function(src){
      if (mine !== ticket) return;
      player.pause(); player.src = src;
      var p = player.play();
      if (p && p.catch) p.catch(function(){ if (!deviceSpeak(text)) onError("Couldn't play the audio."); });
    });
  }
  // Separators like × and / are read as a short pause.
  function clean(t){ return String(t || "").replace(/[×\/\-–_]/g, "، ").replace(/\s+/g, " ").trim(); }

  function speak(text){
    text = clean(text);
    if (!text) return;
    var mine = ++ticket;
    try { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); } catch (e) {}
    if (urls[text]) { unlock(); play(urls[text], text, mine); return; }
    var sb = opts.client && opts.client();
    if (!sb || opts.enabled === false || !navigator.onLine) {
      if (!deviceSpeak(text)) onError(navigator.onLine ? "Audio isn't available yet." : "You're offline. Play this word once while online to hear it offline later.");
      return;
    }
    unlock();
    sb.functions.invoke("speak", {body:{text:text}}).then(function(r){
      if (mine !== ticket) return;   // a newer Listen tap won
      if (r.data && r.data.url) { remember(text, r.data.url); play(r.data.url, text, mine); return; }
      var status = r.error && r.error.context && r.error.context.status;
      if (!deviceSpeak(text)) onError(status === 429 || status === 503
        ? "New audio is paused until tomorrow. Words you've heard before still play."
        : "Couldn't load the audio. Please try again.");
    }).catch(function(){
      if (mine === ticket && !deviceSpeak(text)) onError("Couldn't load the audio. Please try again.");
    });
  }
  return {speak:speak, available:function(){ return opts.enabled !== false || !!arVoice; }};
};
