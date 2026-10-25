/* Breathe Arabic: the main tabs (Home, Learn, Flashcards, Library, and Admin for admins and editors), shared by every signed-in page.
   A bar along the bottom on phones, a row under the header on bigger screens. Each page calls
   BA_TABS.show({reader, admin}) once it knows who is signed in, and BA_TABS.hide() on the signed-out landing page. */
(function(){
"use strict";
var ICONS = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"></path>',
  learn: '<path d="M2 7l10-4 10 4-10 4z"></path><path d="M6 9v6c0 1.5 2.7 3 6 3s6-1.5 6-3V9"></path>',
  cards: '<rect x="3" y="6" width="14" height="14" rx="2"></rect><path d="M7 3h12a2 2 0 0 1 2 2v12"></path>',
  library: '<path d="M3 5h6a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H3z"></path><path d="M21 5h-6a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h7z"></path>',
  admin: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path>'
};
var TABS = [
  {id:"home", label:"Home", href:"./#"},
  {id:"learn", label:"Learn", href:"learn.html"},
  {id:"cards", label:"Flashcards", href:"./#study/cards"},
  {id:"library", label:"Library", href:"read.html"},
  {id:"admin", label:"Admin", href:"admin.html"}
];
var css = document.createElement("style");
css.textContent =
  ".tabbar{display:flex;gap:4px;padding:4px;margin:-8px 0 22px;border-radius:14px;background:var(--step)}" +
  ".tabbar a{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;padding:9px 8px;border-radius:10px;color:var(--muted);text-decoration:none;font-weight:600;font-size:.92rem}" +
  ".tabbar a[aria-current=page]{background:var(--surface);color:var(--ink);box-shadow:0 1px 0 var(--line)}" +
  ".tabbar svg{width:20px;height:20px;flex:none}" +
  "body.has-tabs .top .pillnav,body.has-tabs .topnav{display:none!important}" +
  "@media (max-width:760px){" +
    ".tabbar{position:fixed;left:0;right:0;bottom:0;z-index:25;margin:0;border-radius:0;gap:0;padding:6px 6px calc(8px + env(safe-area-inset-bottom,0px));background:var(--surface);border-top:1px solid var(--line)}" +
    ".tabbar a{flex-direction:column;gap:3px;padding:6px 2px;font-size:.72rem;font-weight:600;background:none!important;box-shadow:none!important}" +
    ".tabbar a[aria-current=page]{color:var(--lapis)}" +
    ".tabbar svg{width:24px;height:24px}" +
    "body.has-tabs{padding-bottom:calc(72px + env(safe-area-inset-bottom,0px))}" +
  "}";
document.head.appendChild(css);

var bar = null, opts = {reader:false, admin:false};
function current(){
  var p = location.pathname;
  if (/learn(\.html)?$/.test(p)) return "learn";
  if (/read(\.html)?$/.test(p)) return "library";
  if (/admin(\.html)?$/.test(p)) return "admin";
  return /^#study/.test(location.hash) ? "cards" : "home";
}
function draw(){
  if (!bar) return;
  var here = current();
  bar.innerHTML = TABS.filter(function(t){ return (t.id !== "library" || opts.reader) && (t.id !== "admin" || opts.admin); }).map(function(t){
    return '<a href="' + t.href + '"' + (t.id === here ? ' aria-current="page"' : "") + '>' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[t.id] + '</svg>' + t.label + '</a>';
  }).join("");
}
window.BA_TABS = {
  show: function(o){
    opts = Object.assign(opts, o || {});
    if (!bar) {
      bar = document.createElement("nav");
      bar.className = "tabbar"; bar.setAttribute("aria-label", "Main");
      var top = document.querySelector(".top");
      if (top && top.parentNode) top.parentNode.insertBefore(bar, top.nextSibling); else document.body.appendChild(bar);
    }
    bar.hidden = false; document.body.classList.add("has-tabs");
    draw();
  },
  hide: function(){ if (bar) bar.hidden = true; document.body.classList.remove("has-tabs"); }
};
window.addEventListener("hashchange", draw);
})();
