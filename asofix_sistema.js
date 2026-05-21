// ASOFIX → Sistema v2 | Corre dentro de ASOFIX (mismo dominio = sin CORS)
(function(){
'use strict';

if (document.getElementById('acbs-panel')) {
  document.getElementById('acbs-panel').remove();
  return;
}

const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbyxoJ_y_0g6BVfUUl8_lIFOMLt43hENmFuSdNQOnDq7zXX_nZaM1AilNxLzfvqL5CLL/exec';
const USER_ID   = 'de6c3d85-016f-4411-8bcf-2add4fdd1fdb';
const CAR_LOT   = 'be867ea4-58da-44aa-99ac-f6389da38aae';

const TEMPLATE_MAP = {
  negociando:'hsm_avisosubaprecio', nuevo_prem:'hsm_primercontacto',
  nuevo_gen:'hsm_primer_contactov2', sin_resp:'hsm_primercontactosinrespuesta',
  retomar:'hsm_reabrirconversacion', precio:'hsm_avisobajaprecio',
  urgencia:'hsm_avisosubaprecio', validar:'hsm_validardecision'
};

const ROTACION = ['10:00','14:00','18:30','11:30','15:30','19:30'];
const NOTE_CODES = ['#venta','#ok','#no','#busy','#cb','#rv','#esp'];

let STATE = {
  leads: [], selected: null, running: false,
  results: {ok:0,skip:0,err:0},
  records: JSON.parse(localStorage.getItem('asofix_records')||'[]')
};

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function today(){
  return new Date().toISOString().split('T')[0];
}

// ── API ──────────────────────────────────────────────────────────────────
async function apiGet(path){
  const r = await fetch('https://app.asofix.com/api'+path,{
    credentials:'include',
    headers:{'Accept':'application/json','timezone':'-3'}
  });
  if(!r.ok) throw new Error(r.status+' '+r.statusText);
  return r.json();
}

async function apiSendWA(leadId, clientId, templateName, phone, nombre){
  const form = new FormData();
  form.append('client_id', clientId);
  form.append('user_id', USER_ID);
  form.append('lead_id', leadId);
  form.append('car_lot_id', CAR_LOT);
  form.append('business_unit','Plan de Ahorro');
  form.append('recipient_id', phone);
  form.append('text','undefined');
  form.append('template', JSON.stringify({
    templateName, params:{nombre_cliente:nombre}, name:templateName
  }));
  const r = await fetch(
    'https://app.asofix.com/api/whatsapp-conversations/'+leadId+'/sendMessage',
    {method:'PUT', credentials:'include', body:form, headers:{'timezone':'-3'}}
  );
  if(!r.ok) throw new Error('WA Error '+r.status);
  return r.json();
}

// ── CLASIFICAR ───────────────────────────────────────────────────────────
function classify(l){
  const dias = parseInt(l.dias)||0;
  const auto = (l.auto||'').toLowerCase();
  const state = (l.state||'').toLowerCase();
  const origin = (l.origen||'').toLowerCase();
  const obs = (l.observation||'').toLowerCase();
  const esEsp = /expert|partner|cronos|jeep|ram/.test(auto);
  const esNeg = state.includes('negoci');
  const esWeb = origin.includes('formulario')||origin.includes('autogestion');
  const esFria = origin.includes('base fr');
  const noteCode = NOTE_CODES.find(c=>obs.includes(c))||null;

  if(noteCode==='#venta'||noteCode==='#no')
    return {seg:'X',prior:'EXCLUIDO',template:null,razon:'Código '+noteCode,score:0,noteCode,hora:'—'};

  let score=5;
  if(esNeg) score+=3; if(esEsp) score+=2; if(esWeb) score+=2;
  if(esFria) score-=3; if(dias===0) score+=2;
  else if(dias<=5) score+=1; else if(dias>20) score-=1;
  score=Math.min(Math.max(score,0),10);

  let seg,prior,tKey,razon;
  if(esNeg)               {seg='A';prior='MÁXIMA';tKey='negociando';razon='En Negociando';}
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

  const prev = STATE.records.filter(r=>r.leadId===l.id).length;
  const hora = ROTACION[prev%ROTACION.length];
  const cierreAuto = prev>=7&&dias<=5;

  return {seg,prior,template:TEMPLATE_MAP[tKey],tKey,razon,score,hora,intentosPrev:prev,cierreAuto,noteCode};
}

// ── REGISTRAR ────────────────────────────────────────────────────────────
function registrar(lead,cl,result){
  const rec={leadId:lead.id,nombre:lead.nombre,template:cl.template,hora:cl.hora,
             date:today(),result,seg:cl.seg,score:cl.score};
  STATE.records.push(rec);
  localStorage.setItem('asofix_records',JSON.stringify(STATE.records.slice(-500)));
  fetch(SHEETS_URL,{method:'POST',mode:'no-cors',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(rec)}).catch(()=>{});
  return rec;
}

// ── CARGAR LEADS ─────────────────────────────────────────────────────────
async function loadLeads(){
  setStatus('Cargando leads...','info');
  try{
    const fields='assignedDate,antiquityDays,fullName,phone,origin,interest,observation,state,client_id';
    const states='states%5B%5D=assigned&states%5B%5D=managing&states%5B%5D=negotiating';
    const data=await apiGet('/leads/?dinamicPagination=true&fields='+fields+'&'+states+'&per_page=50&page=1');
    STATE.leads=(data.data||[]).map(l=>({
      id:l.id,clientId:l.client_id,
      nombre:l.fullName||(l['Client.firstname']+' '+l['Client.lastname']),
      telefono:l.phone,auto:l.interest,origen:l.origin,
      observation:l.observation||'',state:l.state,dias:l.antiquityDays
    }));
    STATE.leads=STATE.leads.map(l=>({...l,cl:classify(l)}))
      .sort((a,b)=>b.cl.score-a.cl.score);
    renderLeads();
    setStatus('✅ '+STATE.leads.length+' leads cargados','ok');
  }catch(e){
    setStatus('❌ Error: '+e.message,'err');
  }
}

// ── BATCH ─────────────────────────────────────────────────────────────────
async function runBatch(){
  if(STATE.running){return;}
  STATE.running=true;
  STATE.results={ok:0,skip:0,err:0};
  const queue=STATE.leads.filter(l=>{
    if(l.cl.seg==='X'||l.cl.cierreAuto) return false;
    return !STATE.records.some(r=>r.leadId===l.id&&r.date===today());
  });
  setStatus('Batch: '+queue.length+' leads en cola...','info');
  addLog('Iniciando batch: '+queue.length+' leads','info');
  for(const lead of queue){
    if(!STATE.running) break;
    try{
      const nombre=lead.nombre.split(' ')[0];
      await apiSendWA(lead.id,lead.clientId,lead.cl.template,lead.telefono,nombre);
      registrar(lead,lead.cl,'enviado');
      STATE.results.ok++;
      addLog('✓ '+lead.nombre+' → '+lead.cl.template+' '+lead.cl.hora,'ok');
    }catch(e){
      STATE.results.err++;
      addLog('✗ '+lead.nombre+': '+e.message,'err');
    }
    updateBatchStats();
    await sleep(2000);
  }
  STATE.running=false;
  setStatus('Batch completo: '+STATE.results.ok+' enviados · '+STATE.results.err+' errores','ok');
  addLog('Batch finalizado','info');
}

// ── UI ────────────────────────────────────────────────────────────────────
const CSS=`
#acbs-panel{position:fixed;top:0;right:0;width:360px;height:100vh;background:#080810;
  border-left:1px solid #1e1e35;z-index:999999;font-family:Arial,sans-serif;
  display:flex;flex-direction:column;color:#e8e8f0;overflow:hidden}
#acbs-panel *{box-sizing:border-box}
.acbs-hdr{background:linear-gradient(135deg,#1e1b4b,#312e81);padding:14px 16px;
  display:flex;align-items:center;gap:10px;border-bottom:1px solid #1e1e35;flex-shrink:0}
.acbs-logo{font-size:12px;font-weight:700;color:#00d4ff;letter-spacing:2px}
.acbs-close{margin-left:auto;background:rgba(255,255,255,0.08);border:none;
  color:#5a5a7a;width:26px;height:26px;border-radius:5px;cursor:pointer;font-size:13px}
.acbs-tabs{display:flex;gap:2px;padding:8px;border-bottom:1px solid #1e1e35;flex-shrink:0}
.acbs-tab{flex:1;padding:6px;border:none;border-radius:5px;font-size:11px;font-weight:600;
  cursor:pointer;color:#5a5a7a;background:none;transition:all 0.15s}
.acbs-tab.active{background:#6c47ff;color:#fff}
.acbs-body{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
.acbs-ctrl{display:flex;gap:6px}
.acbs-btn{flex:1;padding:8px;border:none;border-radius:7px;font-size:11px;font-weight:700;
  cursor:pointer;font-family:Arial;transition:all 0.15s}
.acbs-btn-p{background:#6c47ff;color:#fff}
.acbs-btn-s{background:rgba(255,255,255,0.06);color:#94a3b8;border:1px solid #1e1e35}
.acbs-btn:disabled{opacity:0.4;cursor:not-allowed}
.acbs-lead{padding:10px;background:#0f0f1c;border:1px solid #1e1e35;border-radius:8px;
  cursor:pointer;transition:background 0.15s}
.acbs-lead:hover{background:rgba(108,71,255,0.06)}
.acbs-lead.sel{border-color:#6c47ff;background:rgba(108,71,255,0.1)}
.acbs-lname{font-size:12px;font-weight:600;margin-bottom:3px}
.acbs-lmeta{display:flex;gap:6px;align-items:center;font-size:10px;color:#5a5a7a}
.seg{font-weight:700;font-size:9px;padding:2px 5px;border-radius:3px}
.sA{background:rgba(255,61,90,0.15);color:#ff3d5a}
.sB{background:rgba(255,179,0,0.15);color:#ffb300}
.sD{background:rgba(0,212,255,0.15);color:#00d4ff}
.sE{background:rgba(90,90,122,0.15);color:#5a5a7a}
.sX{background:rgba(90,90,122,0.1);color:#5a5a7a}
.acbs-status{font-size:11px;padding:8px;background:#0f0f1c;border-radius:6px;
  border:1px solid #1e1e35;min-height:30px}
.acbs-log{max-height:160px;overflow-y:auto;display:flex;flex-direction:column;gap:3px}
.acbs-log-e{font-size:10px;font-family:monospace;padding:3px 0;
  border-bottom:1px solid rgba(255,255,255,0.03);display:flex;gap:8px}
.lt{color:#5a5a7a}.lok{color:#00e57a}.lerr{color:#ff3d5a}.linf{color:#00d4ff}.lwrn{color:#ffb300}
.acbs-detail{background:#0f0f1c;border:1px solid #1e1e35;border-radius:8px;padding:12px}
.acbs-row{display:flex;justify-content:space-between;font-size:11px;padding:3px 0;
  border-bottom:1px solid rgba(255,255,255,0.03)}
.acbs-k{color:#5a5a7a}.acbs-v{color:#e8e8f0;font-weight:500;text-align:right}
.stats{display:flex;gap:12px}
.stat{display:flex;flex-direction:column;gap:2px}
.sval{font-size:20px;font-weight:700;font-family:monospace}
.slbl{font-size:10px;color:#5a5a7a}
`;

function buildUI(){
  const style=document.createElement('style');
  style.textContent=CSS;
  document.head.appendChild(style);

  const panel=document.createElement('div');
  panel.id='acbs-panel';
  panel.innerHTML=`
    <div class="acbs-hdr">
      <span style="font-size:18px">🤖</span>
      <span class="acbs-logo">ASOFIX → SISTEMA</span>
      <button class="acbs-close" onclick="document.getElementById('acbs-panel').remove()">✕</button>
    </div>
    <div class="acbs-tabs">
      <button class="acbs-tab active" onclick="acbsTab('leads',this)">Leads</button>
      <button class="acbs-tab" onclick="acbsTab('batch',this)">Batch</button>
      <button class="acbs-tab" onclick="acbsTab('notif',this)">Notif.</button>
    </div>
    <div class="acbs-body">

      <div id="acbs-tab-leads">
        <div class="acbs-ctrl" style="margin-bottom:8px">
          <button class="acbs-btn acbs-btn-s" onclick="loadLeads()">↻ Recargar</button>
          <button class="acbs-btn acbs-btn-p" onclick="runBatch()" id="acbs-batch-btn">⚡ Batch</button>
        </div>
        <div id="acbs-status" class="acbs-status" style="margin-bottom:8px">Iniciando...</div>
        <div id="acbs-leads-list" style="display:flex;flex-direction:column;gap:6px"></div>
        <div id="acbs-lead-detail" style="display:none;margin-top:10px"></div>
      </div>

      <div id="acbs-tab-batch" style="display:none">
        <div style="margin-bottom:12px">
          <div style="font-size:11px;font-weight:700;margin-bottom:8px">ESTADO DEL BATCH</div>
          <div class="stats">
            <div class="stat"><div class="sval" id="bs-ok" style="color:#00e57a">0</div><div class="slbl">Enviados</div></div>
            <div class="stat"><div class="sval" id="bs-skip" style="color:#ffb300">0</div><div class="slbl">Saltados</div></div>
            <div class="stat"><div class="sval" id="bs-err" style="color:#ff3d5a">0</div><div class="slbl">Errores</div></div>
          </div>
        </div>
        <div style="font-size:10px;color:#5a5a7a;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px">LOG</div>
        <div class="acbs-log" id="acbs-log"></div>
      </div>

      <div id="acbs-tab-notif" style="display:none">
        <button class="acbs-btn acbs-btn-s" style="width:100%;margin-bottom:10px" onclick="loadNotif()">↻ Verificar respuestas</button>
        <div id="acbs-notif-list" style="font-size:12px;color:#5a5a7a">Tocá Verificar para buscar respuestas</div>
      </div>

    </div>
  `;
  document.body.appendChild(panel);
}

window.acbsTab=function(tab,btn){
  ['leads','batch','notif'].forEach(t=>{
    document.getElementById('acbs-tab-'+t).style.display=t===tab?'block':'none';
  });
  document.querySelectorAll('.acbs-tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
};

function setStatus(msg,type){
  const el=document.getElementById('acbs-status');
  if(!el) return;
  const colors={ok:'#00e57a',err:'#ff3d5a',info:'#00d4ff',warn:'#ffb300'};
  el.style.color=colors[type]||'#94a3b8';
  el.textContent=msg;
}

function addLog(msg,type){
  const el=document.getElementById('acbs-log');
  if(!el) return;
  const now=new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const e=document.createElement('div');
  e.className='acbs-log-e';
  e.innerHTML='<span class="lt">'+now+'</span><span class="l'+type+'">'+msg+'</span>';
  el.prepend(e);
  // Cambiar a tab batch automáticamente
  document.querySelectorAll('.acbs-tab')[1].click();
}

function updateBatchStats(){
  const {ok,skip,err}=STATE.results;
  ['ok','skip','err'].forEach(k=>{
    const el=document.getElementById('bs-'+k);
    if(el) el.textContent=STATE.results[k];
  });
}

function renderLeads(){
  const list=document.getElementById('acbs-leads-list');
  if(!list) return;
  if(!STATE.leads.length){
    list.innerHTML='<div style="color:#5a5a7a;font-size:12px;text-align:center;padding:20px">Sin leads</div>';
    return;
  }
  list.innerHTML=STATE.leads.slice(0,20).map(l=>{
    const cl=l.cl;
    const scoreColor=cl.score>=7?'#00e57a':cl.score>=4?'#ffb300':'#ff3d5a';
    const proc=STATE.records.some(r=>r.leadId===l.id&&r.date===today());
    return `<div class="acbs-lead${proc?' acbs-lead-proc':''}" onclick="acbsSelectLead('${l.id}')">
      <div class="acbs-lname" style="${proc?'opacity:0.5':''}">
        <span class="seg s${cl.seg}">${cl.seg}</span> ${l.nombre}
        ${cl.cierreAuto?'<span style="color:#ff3d5a;font-size:9px"> ⚠️</span>':''}
      </div>
      <div class="acbs-lmeta">
        <span>${l.auto||'—'}</span>
        <span style="color:${scoreColor};font-family:monospace">${l.dias}d · ${cl.score}/10</span>
        <span style="color:#00d4ff;font-family:monospace;font-size:9px">${cl.hora}</span>
        ${proc?'<span style="color:#00e57a">✓</span>':''}
      </div>
    </div>`;
  }).join('');
}

window.acbsSelectLead=function(id){
  STATE.selected=STATE.leads.find(l=>l.id===id);
  if(!STATE.selected) return;
  document.querySelectorAll('.acbs-lead').forEach(el=>el.classList.remove('sel'));
  event.currentTarget.classList.add('sel');
  renderDetail(STATE.selected);
};

function renderDetail(lead){
  const el=document.getElementById('acbs-lead-detail');
  if(!el) return;
  const cl=lead.cl;
  el.style.display='block';
  const hist=STATE.records.filter(r=>r.leadId===lead.id).slice(-3).reverse()
    .map(r=>`<div style="font-size:10px;color:#5a5a7a;font-family:monospace">${r.date} ${r.hora}: ${r.template?.replace('hsm_','/')||'—'} → ${r.result}</div>`).join('')||
    '<div style="font-size:10px;color:#5a5a7a">Sin intentos previos</div>';

  el.innerHTML=`<div class="acbs-detail">
    <div style="font-size:13px;font-weight:700;margin-bottom:8px">${lead.nombre}</div>
    ${[['Auto',lead.auto],['Origen',lead.origen],['Etapa',lead.state],['Días',lead.dias+'d'],
       ['Segmento',cl.seg+' — '+cl.prior],['Plantilla',cl.template?.replace('hsm_','/')||'—'],
       ['Hora',cl.hora],['Score',cl.score+'/10'],['Razón',cl.razon]]
      .map(([k,v])=>`<div class="acbs-row"><span class="acbs-k">${k}</span><span class="acbs-v">${v||'—'}</span></div>`).join('')}
    <div style="margin-top:10px;margin-bottom:6px;font-size:10px;color:#5a5a7a">HISTORIAL</div>
    ${hist}
    <div style="display:flex;gap:6px;margin-top:10px">
      <button class="acbs-btn acbs-btn-p" onclick="acbsSendOne('${lead.id}')">📤 Enviar WA</button>
      <button class="acbs-btn acbs-btn-s" onclick="acbsCopyPrompt('${lead.id}')">📋 Prompt</button>
    </div>
  </div>`;
}

window.acbsSendOne=async function(id){
  const lead=STATE.leads.find(l=>l.id===id);
  if(!lead||!lead.cl.template){setStatus('⚠️ Sin plantilla asignada','warn');return;}
  setStatus('📤 Enviando...','info');
  try{
    await apiSendWA(lead.id,lead.clientId,lead.cl.template,lead.telefono,lead.nombre.split(' ')[0]);
    registrar(lead,lead.cl,'enviado');
    setStatus('✅ WA enviado a '+lead.nombre,'ok');
    renderDetail(lead);
  }catch(e){
    setStatus('❌ Error: '+e.message,'err');
  }
};

window.acbsCopyPrompt=function(id){
  const lead=STATE.leads.find(l=>l.id===id);
  if(!lead) return;
  const cl=lead.cl;
  const hist=STATE.records.filter(r=>r.leadId===id)
    .map(r=>r.date+' '+r.hora+': '+r.template+' → '+r.result).join('\n');
  const prompt=`Sos mi asistente comercial de planes de ahorro en Autocity. Fecha: ${new Date().toLocaleDateString('es-AR')}

LEAD: ${lead.nombre} | Tel: ${lead.telefono}
Auto: ${lead.auto} | Origen: ${lead.origen} | Etapa: ${lead.state}
Días: ${lead.dias} | Score: ${cl.score}/10 | Segmento: ${cl.seg} | ${cl.prior}
UTM: ${lead.observation||'—'}
Historial:\n${hist||'Sin intentos'}

Devolveme: ÁNGULO PERSONALIZADO: | MENSAJE (máx 3 líneas): | NOTA ASOFIX (200c):`;
  navigator.clipboard.writeText(prompt).then(()=>setStatus('✅ Prompt copiado','ok'));
};

async function loadNotif(){
  const el=document.getElementById('acbs-notif-list');
  el.textContent='Verificando...';
  try{
    const data=await apiGet('/notifications/user/'+USER_ID+'?page=1&unreadOnly=true');
    const notifs=data.notifications||[];
    if(!notifs.length){el.innerHTML='<div style="color:#00e57a">✅ Sin notificaciones pendientes</div>';return;}
    el.innerHTML=notifs.map(n=>`
      <div style="background:#0f0f1c;border:1px solid #1e1e35;border-radius:8px;padding:10px;margin-bottom:8px">
        <div style="font-size:12px;font-weight:700;margin-bottom:4px">${n.title}</div>
        <div style="font-size:11px;color:#5a5a7a;margin-bottom:8px">${new Date(n.time).toLocaleString('es-AR')}</div>
        <a href="https://app.asofix.com${n.redirectUrl}" target="_blank"
           style="font-size:11px;color:#6c47ff;font-weight:700">Ver en ASOFIX →</a>
      </div>`).join('');
  }catch(e){
    el.innerHTML='<div style="color:#ff3d5a">Error: '+e.message+'</div>';
  }
}

// ── INIT ─────────────────────────────────────────────────────────────────
buildUI();
loadLeads();
setInterval(()=>{
  apiGet('/notifications/user/'+USER_ID+'?page=1&unreadOnly=true')
    .then(d=>{
      const n=(d.notifications||[]).length;
      if(n>0){
        const tab=document.querySelectorAll('.acbs-tab')[2];
        if(tab) tab.textContent='Notif. ('+n+')';
      }
    }).catch(()=>{});
},5*60*1000);

})();
