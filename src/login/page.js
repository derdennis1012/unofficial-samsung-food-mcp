/**
 * HTML for the Samsung session handover (local `sf login` page and the hosted consent page).
 *
 * Everything is server-rendered into one page with a small inline script (allowed by a per-response
 * CSP nonce). The page has three steps:
 *   1. connect: bookmarklet (primary) or paste field (fallback)
 *   2. waiting: the page polls the status endpoint until the other tab delivered the session
 *   3. done:    "Connected as <name>", then mode specific: close the tab (local), approve the
 *               connection (hosted connect) or confirm the deletion (hosted disconnect)
 * The landing page is where the bookmarklet arrives with `#n=<nonce>&c=<cookie>`; its script posts
 * the fragment to the server and clears it from the address bar.
 */

import crypto from 'node:crypto';

export const APP_HOST = 'app.samsungfood.com';
export const APP_URL = `https://${APP_HOST}`;

export function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** JSON for embedding inside <script type="application/json"> (no `</script>` breakout). */
const embedJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

export const newScriptNonce = () => crypto.randomBytes(18).toString('base64');

/** Content-Security-Policy for a page rendered with `scriptNonce`. */
export function pageCsp(scriptNonce, { formAction = "'self'" } = {}) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${scriptNonce}'`,
    `style-src 'nonce-${scriptNonce}'`,
    "img-src 'self' data:",
    "connect-src 'self'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * The bookmarklet. It runs on app.samsungfood.com, picks only the session cookie (not the other
 * cookies of the site) and navigates to the landing page with the nonce and the cookie in the URL
 * fragment. A top-level navigation needs no CORS and is not a private-network request.
 */
export function bookmarklet(landingUrl, nonce) {
  const code = `(function(){var h=${JSON.stringify(APP_HOST)};if(location.hostname!==h){if(confirm('This button only works on Samsung Food (' + h + '). You are on ' + location.hostname + '. Open Samsung Food now? Log in there, then click the button again.'))location.href='https://'+h+'/';return}var c=document.cookie.split('; ').filter(function(x){return x.indexOf('whisk.USER_TOKEN=')===0})[0];if(!c){alert('You are not logged in on Samsung Food yet. Log in on this page first, then click the button again.');return}location.href=${JSON.stringify(landingUrl)}+'#n='+${JSON.stringify(nonce)}+'&c='+encodeURIComponent(c)})()`;
  return `javascript:${code}`;
}

const STYLE = `
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#5f6368;--bg:#f6f7f9;--card:#fff;--line:#dfe3e8;--accent:#1f6feb;--ok:#137333;--err:#b3261e;--warn-bg:#fff4e5}
@media (prefers-color-scheme:dark){:root{--fg:#eceff1;--muted:#a7adb3;--bg:#121417;--card:#1b1e22;--line:#30363d;--accent:#58a6ff;--ok:#56d364;--err:#ff7b72;--warn-bg:#2d2416}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:640px;margin:0 auto;padding:32px 20px 48px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;margin:16px 0}
h1{font-size:1.45rem;margin:0 0 4px}h2{font-size:1.1rem;margin:0 0 12px}p{margin:8px 0}.muted{color:var(--muted);font-size:.93rem}
ol{padding-left:1.3em;margin:8px 0}li{margin:8px 0}
.bm{display:inline-block;padding:10px 18px;border-radius:999px;background:var(--accent);color:#fff;font-weight:600;text-decoration:none;cursor:grab;border:2px dashed transparent}
.bm:active{cursor:grabbing}
button,.btn{font:inherit;padding:10px 18px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}button.danger{background:var(--err);border-color:var(--err);color:#fff;font-weight:600}
button:disabled{opacity:.6;cursor:default}
textarea,input[type=text]{width:100%;font:14px ui-monospace,SFMono-Regular,Menlo,monospace;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
textarea{min-height:84px;resize:vertical}label{display:block;font-weight:600;margin:12px 0 6px}
details{margin-top:8px}summary{cursor:pointer;font-weight:600}
.warn{background:var(--warn-bg);border-radius:10px;padding:10px 12px;font-size:.93rem}
.msg{min-height:1.5em;margin-top:10px;font-weight:600}.msg.err{color:var(--err)}.msg.ok{color:var(--ok)}
.done{font-size:1.15rem;color:var(--ok);font-weight:700}.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
footer{margin-top:28px;font-size:.85rem;color:var(--muted)}footer a{color:inherit}
.hidden{display:none}code{font-size:.9em}
`;

/** Client script shared by the login and the landing page. Reads its settings from #cfg. */
const SCRIPT = `
(function(){
var cfg=JSON.parse(document.getElementById('cfg').textContent);
var $=function(id){return document.getElementById(id)};
function show(id,on){var e=$(id);if(e)e.classList.toggle('hidden',!on)}
function msg(id,text,ok){var e=$(id);if(!e)return;e.textContent=text||'';e.className='msg'+(text?(ok?' ok':' err'):'')}
function post(url,body){return fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return {ok:false,error:{message:'Unexpected answer from the server ('+r.status+').'}}})})}
function done(info){
  show('step-connect',false);show('step-done',true);
  var a=$('account');if(a)a.textContent=info.account||'your account';
  if(info.needsInvite)show('invite-box',true);
}
if(cfg.landing){
  var h=new URLSearchParams(location.hash.slice(1));var n=h.get('n'),c=h.get('c');
  history.replaceState(null,'',location.pathname);
  if(!n||!c){msg('landing-msg','Nothing to hand over. Start the login from the login page and use the button there.');return}
  msg('landing-msg','Checking your Samsung Food session...',true);
  post(cfg.handover,{n:n,c:c}).then(function(r){
    if(r.ok){show('landing-wait',false);show('landing-ok',true);$('account').textContent=r.account||'your account';}
    else msg('landing-msg',(r.error&&r.error.message)||'That did not work.');
  }).catch(function(){msg('landing-msg','Could not reach the login page. Is it still open?')});
  return;
}
var bm=$('bookmarklet');
if(bm)bm.addEventListener('click',function(e){e.preventDefault();msg('bm-msg','Drag this button to your bookmarks bar (don\\'t click it here). Then click the bookmark on app.samsungfood.com.')});
var finished=false;
function poll(){
  if(finished)return;
  post(cfg.status,{n:cfg.nonce}).then(function(r){
    if(finished)return;
    if(r.ok&&r.status==='verified'){finished=true;done(r);return}
    if(!r.ok){finished=true;msg('paste-msg',(r.error&&r.error.message)||'The login expired. Reload the page.');return}
    setTimeout(poll,1500);
  }).catch(function(){setTimeout(poll,4000)});
}
setTimeout(poll,1500);
var pf=$('paste-form');
if(pf)pf.addEventListener('submit',function(e){
  e.preventDefault();var b=$('paste-btn');b.disabled=true;msg('paste-msg','Checking...',true);
  post(cfg.handover,{n:cfg.nonce,c:$('paste').value}).then(function(r){
    b.disabled=false;
    if(r.ok){$('paste').value='';finished=true;post(cfg.status,{n:cfg.nonce}).then(function(s){done(s.ok?s:r)})}
    else msg('paste-msg',(r.error&&r.error.message)||'That did not work.');
  }).catch(function(){b.disabled=false;msg('paste-msg','Could not reach the server.')});
});
var df=$('decide-form');
if(df){
  var decide=function(action){
    var btns=df.querySelectorAll('button');btns.forEach(function(x){x.disabled=true});msg('decide-msg','',true);
    var body={n:cfg.nonce,action:action};
    var inv=$('invite');if(inv)body.invite=inv.value;
    var ro=$('read_only');if(ro)body.readOnly=ro.checked;
    post(cfg.decide,body).then(function(r){
      if(r.ok&&r.redirect){msg('decide-msg',r.message||'Done.',true);location.assign(r.redirect);return}
      if(r.ok){finished=true;show('decide-form',false);msg('decide-msg',r.message||'Done.',true);return}
      btns.forEach(function(x){x.disabled=false});msg('decide-msg',(r.error&&r.error.message)||'That did not work.');
    }).catch(function(){btns.forEach(function(x){x.disabled=false});msg('decide-msg','Could not reach the server.')});
  };
  df.addEventListener('submit',function(e){e.preventDefault();decide(e.submitter&&e.submitter.value==='deny'?'deny':'approve')});
}
})();
`;

function layout({ title, scriptNonce, body, cfg, footer = '' }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style nonce="${scriptNonce}">${STYLE}</style></head>
<body><main>${body}${footer ? `<footer>${footer}</footer>` : ''}</main>
<script type="application/json" id="cfg">${embedJson(cfg)}</script>
<script nonce="${scriptNonce}">${SCRIPT}</script></body></html>`;
}

/**
 * Login page.
 * @param {object} o
 * @param {'local'|'connect'|'disconnect'} o.mode
 * @param {string} o.nonce          pending login
 * @param {string} o.landingUrl     absolute URL of the landing page (target of the bookmarklet)
 * @param {{handover: string, status: string, decide?: string}} o.endpoints  same-origin paths
 * @param {string} o.scriptNonce
 * @param {string} [o.heading]
 * @param {string} [o.intro]        HTML (trusted)
 * @param {string} [o.doneHtml]     HTML shown after "Connected as" (trusted)
 * @param {string} [o.footer]       HTML (trusted)
 */
export function loginPage({ mode, nonce, landingUrl, endpoints, scriptNonce, heading = 'Connect Samsung Food', intro = '', doneHtml = '', footer = '' }) {
  const href = bookmarklet(landingUrl, nonce);
  const body = `
<h1>${escapeHtml(heading)}</h1>
${intro}
<section id="step-connect">
<div class="card">
<h2>Easiest: one button</h2>
<ol>
<li>Drag this button to your bookmarks bar:&nbsp; <a class="bm" id="bookmarklet" href="${escapeHtml(href)}">Send to ${mode === 'local' ? 'sf login' : 'connector'}</a>
<div class="msg" id="bm-msg"></div>
<div class="muted">No bookmarks bar? Press <code>Ctrl+Shift+B</code> (Windows, Linux) or <code>Cmd+Shift+B</code> (Mac).</div></li>
<li>Open <a href="${APP_URL}" target="_blank" rel="noopener noreferrer">${APP_HOST}</a> in this browser and log in.</li>
<li>Click the bookmark there. This page continues by itself.</li>
</ol>
<p class="muted">The button works once and for the next 10 minutes. It only reads the Samsung Food session cookie and sends it here; nothing else from the site.</p>
</div>
<div class="card">
<details id="paste-box"><summary>Other ways: paste the session</summary>
<p>On ${APP_HOST}, open the developer console (<code>F12</code> or <code>Cmd+Option+J</code>), run <code>copy(document.cookie)</code> and paste the result here. A bare token, <code>Bearer &lt;token&gt;</code> or a "Copy as cURL" command work too.</p>
<form id="paste-form" autocomplete="off">
<label for="paste">Session from Samsung Food</label>
<textarea id="paste" name="paste" spellcheck="false" autocomplete="off" required></textarea>
<p class="warn">This value works like your password: it gives full access to your Samsung Food account. Only paste it here, never in a chat.</p>
<div class="row"><button class="primary" id="paste-btn" type="submit">Connect</button></div>
<div class="msg" id="paste-msg"></div>
</form>
</details>
</div>
</section>
<section id="step-done" class="hidden">
<div class="card">
<p class="done">Connected as <span id="account"></span></p>
${doneHtml}
</div>
</section>`;
  return layout({ title: heading, scriptNonce, body, footer, cfg: { nonce, mode, handover: endpoints.handover, status: endpoints.status, decide: endpoints.decide ?? null } });
}

/** Page the bookmarklet opens. It never renders secrets; the fragment is handled by the script. */
export function landingPage({ endpoints, scriptNonce, returnHint = 'Go back to the window where you started; it continues there by itself. You can close this tab.', footer = '' }) {
  const body = `
<h1>Samsung Food</h1>
<div class="card">
<div id="landing-wait"><noscript><p>This page needs JavaScript.</p></noscript><div class="msg" id="landing-msg"></div></div>
<div id="landing-ok" class="hidden"><p class="done">Connected as <span id="account"></span></p><p>${escapeHtml(returnHint)}</p></div>
</div>`;
  return layout({ title: 'Samsung Food', scriptNonce, body, footer, cfg: { landing: true, handover: endpoints.handover } });
}

/** A plain message page (errors, placeholders). */
export function messagePage({ title, html, scriptNonce = newScriptNonce(), footer = '' }) {
  return layout({ title, scriptNonce, body: `<h1>${escapeHtml(title)}</h1><div class="card">${html}</div>`, footer, cfg: {} });
}
