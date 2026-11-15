// Mobile layer: bottom navigation (Home / Cultures / GIS map) and the collapsible region card.
// It only adds behaviour on top of portal.js and main.js; no data or existing feature is changed.
import {tt,onLang} from './i18n.js';
import {icon} from './icons.js';
import './shell.js';

const $=id=>document.getElementById(id);
const nav=$('bottomNav');

function currentSection(){
 if(document.body.classList.contains('map-visible'))return 'map';
 return document.querySelector('#portalContent .welcome-layout')?'welcome':'catalog';
}
function paintNav(){
 if(!nav)return;
 const now=currentSection();
 nav.querySelectorAll('[data-nav]').forEach(b=>{
  const on=b.dataset.nav===now;
  b.classList.toggle('current',on);
  if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
 });
}
// From the map, Home and Cultures first return to the portal (portal.js then switches the view).
nav?.addEventListener('click',e=>{
 const b=e.target.closest('[data-nav]');if(!b)return;
 if(document.body.classList.contains('map-visible')&&b.dataset.nav!=='map')$('backToPortal')?.click();
});

// ---- Region card (mobile): collapsed = name + location, expanded = everything the site already knows.
let siteInfo=null,siteInfoRequested=false;
async function loadSite(){
 if(siteInfoRequested)return;siteInfoRequested=true;
 try{const r=await fetch('/api/sites',{cache:'no-store'});if(r.ok){const d=await r.json();siteInfo=(d.sites||[])[0]||null}}catch(_){}
 document.querySelectorAll('.region-card').forEach(fillExtra);
}
const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fillExtra(card){
 const box=card.querySelector('.region-extra');if(!box||!siteInfo)return;
 const rows=[];
 if(Number.isFinite(siteInfo.lat)&&Number.isFinite(siteInfo.lon))rows.push(`<div class="region-row"><small>${tt('reg.coords')}</small><strong>${siteInfo.lat}, ${siteInfo.lon}</strong></div>`);
 if(/^https:\/\//.test(siteInfo.verified_source||''))rows.push(`<a class="region-link" href="${safe(siteInfo.verified_source)}" target="_blank" rel="noopener noreferrer">${tt('reg.source')} · UNL SCAL</a>`);
 box.innerHTML=rows.join('');
}
function paintToggle(card){
 const btn=card.querySelector('.region-toggle');if(!btn)return;
 const open=!card.classList.contains('collapsed');
 btn.setAttribute('aria-expanded',String(open));
 btn.querySelector('.rt-label').textContent=tt(open?'reg.less':'reg.more');
}
function enhanceRegionCards(){
 document.querySelectorAll('#portalContent .farm-status:not([data-card])').forEach(card=>{
  card.dataset.card='1';card.classList.add('region-card','collapsed');
  const extra=document.createElement('div');extra.className='region-extra';card.appendChild(extra);
  const btn=document.createElement('button');btn.type='button';btn.className='region-toggle';
  btn.innerHTML=`<span class="rt-label"></span><span class="rt-ico">${icon('chevron',16)}</span>`;
  btn.addEventListener('click',()=>{card.classList.toggle('collapsed');paintToggle(card)});
  card.appendChild(btn);paintToggle(card);fillExtra(card);loadSite();
 });
}
const host=$('portalContent');
if(host)new MutationObserver(()=>{enhanceRegionCards();paintNav()}).observe(host,{childList:true});
new MutationObserver(paintNav).observe(document.body,{attributes:true,attributeFilter:['class']});
onLang(()=>{document.querySelectorAll('.region-card').forEach(c=>{paintToggle(c);fillExtra(c)})});
enhanceRegionCards();paintNav();
