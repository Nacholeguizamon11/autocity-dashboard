// ASOFIX → Sistema v3 | Captura token automáticamente
(function(){
'use strict';

if(document.getElementById('acbs-panel')){
  document.getElementById('acbs-panel').remove();
  return;
}

const SHEETS_URL='https://script.google.com/macros/s/AKfycbyxoJ_y_0g6BVfUUl8_lIFOMLt43hENmFuSdNQOnDq7zXX_nZaM1AilNxLzfvqL5CLL/exec';
const USER_ID='de6c3d85-016f-4411-8bcf-2add4fdd1fdb';
const CAR_LOT='be867ea4-58da-44aa-99ac-f6389da38aae';
const ROTACION=['10:00','14:00','18:30','11:30','15:30','19:30'];
const NOTE_CODES=['#venta','#ok','#no','#busy','#cb','#rv','#esp'];
const TMAP={
  negociando:'hsm_avisosubaprecio',nuevo_prem:'hsm_primercontacto',
  nuevo_gen:'hsm_primer_contactov2',sin_resp:'hsm_primercontactosinrespuesta',
  retomar:'hsm_reabrirconversacion',precio:'hsm_avisobajaprecio',
  urgencia:'hsm_avisosubaprecio',validar:'hsm_validardecision'
};

let AUTH_TOKEN=null;
let STATE={leads:[],selected:null,running:false,
  results:{ok:0,skip:0,err:0},
  records:JSON.parse(localStorage.getItem('asofix_records')||'[]')};

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function today(){return new Date().toISOString().split('T')[0];}

// ── LEER TOKEN DESDE localStorage ────────────────────────────────────────
function interceptToken(){
  // ASOFIX guarda el token en localStorage con key "token"
  const stored = localStorage.getItem('token');
  if(stored && stored.startsWith('eyJ')){
    AUTH_TOKEN = 'Bearer ' + stored;
    return;
  }
  // Fallback: buscar en todas las keys
  for(const k of Object.keys(localStorage)){
    const v = localStorage.getItem(k);
    if(v && v.startsWith('eyJ') && v.length > 100){
      AUTH_TOKEN = 'Bearer ' + v;
      return;
    }
    if(v && v.includes('"token"')){
      try{
        const p = JSON.parse(v);
        if(p.token && p.token.startsWith('eyJ')){
          AUTH_TOKEN = 'Bearer ' + p.token;
          return;
        }
      }catch(e){}
    }
  }
}

// ── API ──────────────────────────────────────────────────────────────────
function getHeaders(){
  const h={'Accept':'application/json','timezone':'-3','Cache-Control':'no-cache'};
  if(AUTH_TOKEN){
    h['Authorization'] = AUTH_TOKEN.startsWith('Bearer ') ? AUTH_TOKEN : 'Bearer '+AUTH_TOKEN;
  }
  return h;
}

async function apiGet(path){
  const r=await fetch('https://app.asofix.com/api'+path,
    {credentials:'include',headers:getHeaders()});
  if(!r.ok) throw new Error(r.status+' '+r.statusText);
  return r.json();
}

async function apiSendWA(leadId,clientId,templateName,phone,nombre){
  const form=new FormData();
  form.append('client_id',clientId);
  form.append('user_id',USER_ID);
  form.append('lead_id',leadId);
  form.append('car_lot_id',CAR_LOT);
  form.append('business_unit','Plan de Ahorro');
  form.append('recipient_id',phone);
  form.append('text','undefined');
  form.append('template',JSON.stringify({
    templateName,params:{nombre_cliente:nombre},name:templateName
  }));
  const h=getHeaders();
  delete h['Accept'];
  const r=await fetch(
    'https://app.asofix.com/api/whatsapp-conversations/'+leadId+'/sendMessage',
    {method:'PUT',credentials:'include',body:form,headers:h});
  if(!r.ok) throw new Error('WA Error '+r.status);
  return r.json();
}

// ── CLASIFICAR ───────────────────────────────────────────────────────────
function classify(l){
  const dias=parseInt(l.dias)||0;
  const auto=(l.auto||'').toLowerCase();
  const state=(l.state||'').toLowerCase();
  const origin=(l.origen||'').toLowerCase();
  const obs=(l.observation||'').toLowerCase();
  const esEsp=/expert|partner|cronos|jeep|ram/.test(auto);
  const esNeg=state.includes('negoci');
  const esWeb=origin.includes('formulario')||origin.includes('autogestion');
  const esFria=origin.includes('base fr');
  const noteCode=NOTE_CODES.find(c=>obs.includes(c))||null;

  if(noteCode==='#venta'||noteCode==='#no')
    return{seg:'X',prior:'EXCLUIDO',template:null,razon:'Código '+noteCode,score:0,noteCode,hora:'—'};

  let score=5;
  if(esNeg)score+=3;if(esEsp)score+=2;if(esWeb)score+=2;
  if(esFria)score-=3;if(dias===0)score+=2;
  else if(dias<=5)score+=1;else if(dias>20)score-=1;
  score=Math.min(Math.max(score,0),10);

  let seg,prior,tKey,razon;
  if(esNeg)               {seg='A';prior='MÁXIMA';tKey='negociando';razon='Negociando';}
  else if(dias===0&&esEsp){seg='A';prior='MÁXIMA';tKey='nuevo_prem';razon='Nuevo premium';}
  else if(dias===0&&esWeb){seg='A';prior='MÁXIMA';tKey='nuevo_prem';razon='Web alta intención';}
  else if(dias===0)       {seg='B';prior='ALTA';  tKey='nuevo_gen'; razon='Lead nuevo';}
  else if(dias<=4)        {seg='B';prior='ALTA';  tKey='sin_resp';  razon=dias+'d sin resp.';}
  else if(dias<=10&&esEsp){seg='A';prior='MÁXIMA';tKey='retomar';   razon=dias+'d premium';}
  else if(dias<=10)       {seg='B';prior='ALTA';  tKey='retomar';   razon=dias+'d retomar';}
  else if(dias<=20)       {seg='D';prior='MEDIA'; tKey='precio';    razon=dias+'d precio';}
  else if(dias<=35)       {seg='D';prior='MEDIA'; tKey='urgencia';  razon=dias+'d urgencia';}
  else                    {seg='E';prior='BAJA';  tKey='validar';   razon='+'+dias+'d backlog';}
  if(esFria&&seg!=='A')   {seg='E';prior='BAJA';  tKey='nuevo_gen'; score=Math.min(score,3);}

  const prev=STATE.records.filter(r=>r.leadId===l.id).length;
  const hora=ROTACION[prev%ROTACION.length];
  const cierreAuto=prev>=7&&dias<=5;
  return{seg,prior,template:TMAP[tKey],tKey,razon,score,hora,intentosPrev:prev,cierreAuto,noteCode};
}

// ── REGISTRAR ────────────────────────────────────────────────────────────
function registrar(lead,cl,result){
  const rec={leadId:lead.id,nombre:lead.nombre,template:cl.template,
    hora:cl.hora,date:today(),result,seg:cl.seg,score:cl.score};
  STATE.records.push(rec);
  localStorage.setItem('asofix_records',JSON.stringify(STATE.records.slice(-500)));
  fetch(SHEETS_URL,{method:'POST',mode:'no-cors',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(rec)}).catch(()=>{});
}

// ── CARGAR LEADS ─────────────────────────────────────────────────────────
async function loadLeads(){
  setStatus('Cargando leads...','info');
  // Leer token fresco del localStorage
  interceptToken();
  if(!AUTH_TOKEN){
    setStatus('⚠️ No se encontró el token. Cerrá sesión y volvé a entrar a ASOFIX','warn');
    return;
  }
  try{
    const fields='assignedDate,antiquityDays,fullName,phone,origin,interest,observation,state,client_id';
    const data=await apiGet('/leads/?dinamicPagination=true&fields='+fields+
      '&states[]=assigned&states[]=managing&states[]=negotiating&per_page=50&page=1');
    STATE.leads=(data.data||[]).map(l=>({
      id:l.id,clientId:l.client_id,
      nombre:l.fullName||(l['Client.firstname']||'')+' '+(l['Client.lastname']||''),
      telefono:l.phone,auto:l.interest,origen:l.origin,
      observation:l.observation||'',state:l.state,dias:l.antiquityDays
    }));
    STATE.leads=STATE.leads.map(l=>({...l,cl:classify(l)}))
      .sort((a,b)=>b.cl.score-a.cl.score);
    renderLeads();
    setStatus('✅ '+STATE.leads.length+' leads cargados','ok');
  }catch(e){
    setStatus('❌ '+e.message,'err');
  }
}

// ── BATCH ─────────────────────────────────────────────────────────────────
async function runBatch(){
  if(STATE.running)return;
  STATE.running=true;
  STATE.results={ok:0,skip:0,err:0};
  const queue=STATE.leads.filter(l=>{
    if(l.cl.seg==='X'||l.cl.cierreAuto)return false;
    return !STATE.records.some(r=>r.leadId===l.id&&r.date===today());
  });
  setStatus('Batch: '+queue.length+' leads','info');
  addLog('Iniciando: '+queue.length+' leads','info');
  switchTab('batch');
  for(const lead of queue){
    if(!STATE.running)break;
    try{
      await apiSendWA(lead.id,lead.clientId,lead.cl.template,
        lead.telefono,lead.nombre.split(' ')[0]);
      registrar(lead,lead.cl,'enviado');
      STATE.results.ok++;
      addLog('✓ '+lead.nombre+' → /'+lead.cl.template?.replace('hsm_','')+' '+lead.cl.hora,'ok');
    }catch(e){
      STATE.results.err++;
      addLog('✗ '+lead.nombre+': '+e.message,'err');
    }
    updateBatchStats();
    await sleep(2000);
  }
  STATE.running=false;
  setStatus('✅ Batch: '+STATE.results.ok+' enviados · '+STATE.results.err+' errores','ok');
}

// ── UI ────────────────────────────────────────────────────────────────────
const CSS=`
#acbs-panel{position:fixed;top:0;right:0;width:360px;height:100vh;background:#080810;
border-left:1px solid #1e1e35;z-index:2147483647;font-family:Arial,sans-serif;
display:flex;flex-direction:column;color:#e8e8f0;overflow:hidden;box-shadow:-8px 0 32px rgba(0,0,0,0.5)}
#acbs-panel *{box-sizing:border-box;font-family:Arial,sans-serif}
.acbs-hdr{background:linear-gradient(135deg,#1e1b4b,#312e81);padding:12px 16px;
display:flex;align-items:center;gap:10px;border-bottom:1px solid #1e1e35;flex-shrink:0}
.acbs-logo{font-size:11px;font-weight:700;color:#00d4ff;letter-spacing:2px;flex:1}
.acbs-close{background:rgba(255,255,255,0.08);border:none;color:#5a5a7a;
width:26px;height:26px;border-radius:5px;cursor:pointer;font-size:14px;line-height:1}
.acbs-tabs{display:flex;gap:2px;padding:8px;border-bottom:1px solid #1e1e35;flex-shrink:0;background:#0a0a14}
.acbs-tab{flex:1;padding:7px 4px;border:none;border-radius:5px;font-size:11px;font-weight:700;
cursor:pointer;color:#5a5a7a;background:none;transition:all 0.15s}
.acbs-tab.on{background:#6c47ff;color:#fff}
.acbs-body{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.acbs-body::-webkit-scrollbar{width:3px}
.acbs-body::-webkit-scrollbar-thumb{background:#1e1e35}
.ab{flex:1;padding:8px 6px;border:none;border-radius:7px;font-size:11px;font-weight:700;
cursor:pointer;transition:all 0.15s}
.ab-p{background:#6c47ff;color:#fff}
.ab-s{background:rgba(255,255,255,0.06);color:#94a3b8;border:1px solid #1e1e35}
.ab:disabled{opacity:0.4;cursor:not-allowed}
.al{padding:10px;background:#0f0f1c;border:1px solid #1e1e35;border-radius:8px;
cursor:pointer;transition:background 0.15s;margin-bottom:6px}
.al:hover{background:rgba(108,71,255,0.06)}
.al.sel{border-color:#6c47ff;background:rgba(108,71,255,0.1)}
.an{font-size:12px;font-weight:600;margin-bottom:3px;display:flex;align-items:center;gap:5px}
.am{display:flex;gap:6px;align-items:center;font-size:10px;color:#5a5a7a}
.sg{font-weight:700;font-size:9px;padding:2px 5px;border-radius:3px}
.sA{background:rgba(255,61,90,0.15);color:#ff3d5a}
.sB{background:rgba(255,179,0,0.15);color:#ffb300}
.sD{background:rgba(0,212,255,0.15);color:#00d4ff}
.sE,.sX{background:rgba(90,90,122,0.15);color:#5a5a7a}
.ast{font-size:11px;padding:8px 10px;background:#0f0f1c;border-radius:6px;
border:1px solid #1e1e35;min-height:30px}
.alog{max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:3px}
.ale{font-size:10px;font-family:monospace!important;padding:3px 0;
border-bottom:1px solid rgba(255,255,255,0.03);display:flex;gap:8px}
.lt{color:#5a5a7a!important}.lok{color:#00e57a!important}
.ler{color:#ff3d5a!important}.lin{color:#00d4ff!important}.lw{color:#ffb300!important}
.sts{display:flex;gap:14px;margin-bottom:10px}
.sv{font-size:22px;font-weight:700;font-family:monospace!important}
.sl{font-size:10px;color:#5a5a7a}
.adr{background:#0f0f1c;border:1px solid #1e1e35;border-radius:8px;padding:12px}
.arr{display:flex;justify-content:space-between;font-size:11px;padding:3px 0;
border-bottom:1px solid rgba(255,255,255,0.03)}
.ark{color:#5a5a7a}.arv{color:#e8e8f0;font-weight:500;text-align:right;max-width:55%;word-break:break-all}
`;

function buildUI(){
  if(document.getElementById('acbs-style')) document.getElementById('acbs-style').remove();
  const st=document.createElement('style');
  st.id='acbs-style';st.textContent=CSS;
  document.head.appendChild(st);

  const p=document.createElement('div');
  p.id='acbs-panel';
  p.innerHTML=`
    <div class="acbs-hdr">
      <span style="font-size:16px">🤖</span>
      <span class="acbs-logo">ASOFIX → SISTEMA v3</span>
      <button class="acbs-close" id="acbs-x">✕</button>
    </div>
    <div class="acbs-tabs">
      <button class="acbs-tab on" id="tab-leads" onclick="switchTab('leads')">Leads</button>
      <button class="acbs-tab" id="tab-batch" onclick="switchTab('batch')">Batch</button>
      <button class="acbs-tab" id="tab-notif" onclick="switchTab('notif')">Notif.</button>
    </div>

    <div id="acbs-leads" class="acbs-body">
      <div style="display:flex;gap:6px">
        <button class="ab ab-s" onclick="loadLeads()">↻ Recargar</button>
        <button class="ab ab-p" onclick="runBatch()">⚡ Batch</button>
      </div>
      <div class="ast" id="acbs-st">Iniciando sistema...</div>
      <div id="acbs-list"></div>
      <div id="acbs-det" style="display:none"></div>
    </div>

    <div id="acbs-batch" class="acbs-body" style="display:none">
      <div class="sts">
        <div><div class="sv" id="bs-ok" style="color:#00e57a">0</div><div class="sl">Enviados</div></div>
        <div><div class="sv" id="bs-sk" style="color:#ffb300">0</div><div class="sl">Saltados</div></div>
        <div><div class="sv" id="bs-er" style="color:#ff3d5a">0</div><div class="sl">Errores</div></div>
      </div>
      <div class="alog" id="acbs-log"></div>
    </div>

    <div id="acbs-notif" class="acbs-body" style="display:none">
      <button class="ab ab-s" style="width:100%" onclick="loadNotif()">↻ Verificar respuestas</button>
      <div id="acbs-nlist" style="font-size:12px;color:#5a5a7a;margin-top:8px">Tocá Verificar</div>
    </div>
  `;
  document.body.appendChild(p);
  document.getElementById('acbs-x').onclick=()=>p.remove();
}

window.switchTab=function(t){
  ['leads','batch','notif'].forEach(x=>{
    document.getElementById('acbs-'+x).style.display=x===t?'flex':'none';
    document.getElementById('tab-'+x)?.classList.toggle('on',x===t);
  });
};

function setStatus(msg,type){
  const el=document.getElementById('acbs-st');
  if(!el)return;
  const c={ok:'#00e57a',err:'#ff3d5a',info:'#00d4ff',warn:'#ffb300'};
  el.style.color=c[type]||'#94a3b8';
  el.textContent=msg;
}

function addLog(msg,type){
  const el=document.getElementById('acbs-log');
  if(!el)return;
  const now=new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const e=document.createElement('div');
  e.className='ale';
  e.innerHTML='<span class="lt">'+now+'</span><span class="l'+type[0]+'">'+msg+'</span>';
  el.prepend(e);
}

function updateBatchStats(){
  ['ok','sk','er'].forEach((k,i)=>{
    const el=document.getElementById('bs-'+k);
    if(el) el.textContent=[STATE.results.ok,STATE.results.skip||0,STATE.results.err][i];
  });
}

function renderLeads(){
  const list=document.getElementById('acbs-list');
  if(!list)return;
  if(!STATE.leads.length){
    list.innerHTML='<div style="color:#5a5a7a;font-size:12px;text-align:center;padding:20px">Sin leads</div>';
    return;
  }
  list.innerHTML=STATE.leads.slice(0,25).map(l=>{
    const cl=l.cl;
    const sc=cl.score>=7?'#00e57a':cl.score>=4?'#ffb300':'#ff3d5a';
    const proc=STATE.records.some(r=>r.leadId===l.id&&r.date===today());
    return`<div class="al" onclick="selLead('${l.id}')" style="${proc?'opacity:0.5':''}">
      <div class="an">
        <span class="sg s${cl.seg}">${cl.seg}</span>
        ${l.nombre}
        ${cl.cierreAuto?'<span style="color:#ff3d5a;font-size:9px">⚠️</span>':''}
        ${proc?'<span style="color:#00e57a;font-size:10px;margin-left:auto">✓</span>':''}
      </div>
      <div class="am">
        <span>${l.auto||'—'}</span>
        <span style="color:${sc};font-family:monospace">${l.dias}d·${cl.score}/10</span>
        <span style="color:#00d4ff;font-family:monospace;font-size:9px">${cl.hora}</span>
      </div>
    </div>`;
  }).join('');
}

window.selLead=function(id){
  STATE.selected=STATE.leads.find(l=>l.id===id);
  if(!STATE.selected)return;
  document.querySelectorAll('.al').forEach(el=>el.classList.remove('sel'));
  event.currentTarget.classList.add('sel');
  renderDetail(STATE.selected);
};

function renderDetail(lead){
  const el=document.getElementById('acbs-det');
  if(!el)return;
  el.style.display='block';
  const cl=lead.cl;
  const hist=STATE.records.filter(r=>r.leadId===lead.id).slice(-3).reverse()
    .map(r=>`<div style="font-size:10px;color:#5a5a7a;font-family:monospace;padding:2px 0">
      ${r.date} ${r.hora}: /${r.template?.replace('hsm_','')||'?'} → ${r.result}</div>`).join('')||
    '<div style="font-size:10px;color:#5a5a7a">Sin intentos previos</div>';

  el.innerHTML=`<div class="adr">
    <div style="font-size:13px;font-weight:700;margin-bottom:10px">${lead.nombre}</div>
    ${[['Auto',lead.auto],['Origen',lead.origen],['Etapa',lead.state],
       ['Días',lead.dias+'d'],['Segmento',cl.seg+' '+cl.prior],
       ['Plantilla','/'+(cl.template?.replace('hsm_','')||'—')],
       ['Hora',cl.hora],['Score',cl.score+'/10'],['Razón',cl.razon]]
      .map(([k,v])=>`<div class="arr"><span class="ark">${k}</span>
        <span class="arv" style="${k==='Plantilla'?'color:#00d4ff':''}">${v||'—'}</span></div>`).join('')}
    <div style="margin:10px 0 6px;font-size:10px;color:#5a5a7a;letter-spacing:1px;text-transform:uppercase">HISTORIAL</div>
    ${hist}
    <div style="display:flex;gap:6px;margin-top:12px">
      <button class="ab ab-p" onclick="sendOne('${lead.id}')">📤 Enviar WA</button>
      <button class="ab ab-s" onclick="copyPrompt('${lead.id}')">📋 Prompt</button>
    </div>
  </div>`;
}

window.sendOne=async function(id){
  const lead=STATE.leads.find(l=>l.id===id);
  if(!lead||!lead.cl.template){setStatus('⚠️ Sin plantilla','warn');return;}
  setStatus('📤 Enviando...','info');
  try{
    await apiSendWA(lead.id,lead.clientId,lead.cl.template,
      lead.telefono,lead.nombre.split(' ')[0]);
    registrar(lead,lead.cl,'enviado');
    setStatus('✅ WA enviado a '+lead.nombre,'ok');
    renderDetail(lead);
  }catch(e){setStatus('❌ '+e.message,'err');}
};

window.copyPrompt=function(id){
  const lead=STATE.leads.find(l=>l.id===id);
  if(!lead)return;
  const cl=lead.cl;
  const hist=STATE.records.filter(r=>r.leadId===id)
    .map(r=>r.date+' '+r.hora+': /'+r.template?.replace('hsm_','')+' → '+r.result).join('\n');
  const txt=`Sos mi asistente comercial planes de ahorro Autocity. Fecha: ${new Date().toLocaleDateString('es-AR')}
LEAD: ${lead.nombre} | Tel: ${lead.telefono}
Auto: ${lead.auto} | Origen: ${lead.origen} | Etapa: ${lead.state}
Días: ${lead.dias} | Score: ${cl.score}/10 | Seg: ${cl.seg} ${cl.prior}
UTM: ${lead.observation||'—'}
Historial:\n${hist||'Sin intentos'}
Devolveme: ÁNGULO: | MENSAJE (3 líneas): | NOTA ASOFIX (200c):`;
  navigator.clipboard.writeText(txt).then(()=>setStatus('✅ Prompt copiado','ok'));
};

async function loadNotif(){
  const el=document.getElementById('acbs-nlist');
  el.textContent='Verificando...';
  try{
    const data=await apiGet('/notifications/user/'+USER_ID+'?page=1&unreadOnly=true');
    const n=data.notifications||[];
    if(!n.length){el.innerHTML='<div style="color:#00e57a">✅ Sin notificaciones pendientes</div>';return;}
    el.innerHTML=n.map(x=>`<div style="background:#0f0f1c;border:1px solid #1e1e35;border-radius:8px;padding:10px;margin-bottom:8px">
      <div style="font-size:12px;font-weight:700;margin-bottom:4px">${x.title||'—'}</div>
      <div style="font-size:10px;color:#5a5a7a;margin-bottom:8px">${new Date(x.time).toLocaleString('es-AR')}</div>
      <a href="https://app.asofix.com${x.redirectUrl||''}" target="_blank"
        style="font-size:11px;color:#6c47ff;font-weight:700">Ver en ASOFIX →</a>
    </div>`).join('');
  }catch(e){el.innerHTML='<div style="color:#ff3d5a">Error: '+e.message+'</div>';}
}

// ── INIT ──────────────────────────────────────────────────────────────────
interceptToken();
buildUI();

// Intentar cargar leads — si no hay token aún, esperar que ASOFIX haga un request
setTimeout(loadLeads, 800);

// Auto-check notificaciones cada 5 min
setInterval(()=>{
  if(!AUTH_TOKEN)return;
  apiGet('/notifications/user/'+USER_ID+'?page=1&unreadOnly=true')
    .then(d=>{
      const n=(d.notifications||[]).length;
      if(n>0){const t=document.getElementById('tab-notif');if(t)t.textContent='Notif.('+n+')';}
    }).catch(()=>{});
},5*60*1000);

})();
