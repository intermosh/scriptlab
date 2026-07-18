// Dependencias integradas: la app funciona también cuando Opera abre index.html con file://.
let database;
function openDB(){if(database)return Promise.resolve(database);return new Promise((resolve,reject)=>{const r=indexedDB.open('scriptlab-ai',3);r.onupgradeneeded=()=>{const d=r.result;['projects','snapshots','calibrations','settings','analysisCache','modelRegistry','references'].forEach(n=>{if(!d.objectStoreNames.contains(n))d.createObjectStore(n,{keyPath:'id'})})};r.onsuccess=()=>{database=r.result;resolve(database)};r.onerror=()=>reject(r.error)})}
async function put(store,value){const d=await openDB();return new Promise((resolve,reject)=>{const r=d.transaction(store,'readwrite').objectStore(store).put(value);r.onsuccess=()=>resolve(value);r.onerror=()=>reject(r.error)})}
async function get(store,id){const d=await openDB();return new Promise((resolve,reject)=>{const r=d.transaction(store,'readonly').objectStore(store).get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function all(store){const d=await openDB();return new Promise((resolve,reject)=>{const r=d.transaction(store,'readonly').objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function del(store,id){const d=await openDB();return new Promise((resolve,reject)=>{const r=d.transaction(store,'readwrite').objectStore(store).delete(id);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error)})}
async function migrateLegacy(){if(localStorage.getItem('scriptlab-idb-migrated'))return;const raw=localStorage.getItem('scriptlab-ai-project-v1');if(raw)try{const rawProject=JSON.parse(raw),meta=rawProject.project||rawProject;await put('projects',{...meta,id:'active',blocks:Array.isArray(rawProject.blocks)?rawProject.blocks:[],updatedAt:Date.now()})}catch(error){console.warn('No se pudo migrar proyecto anterior',error)}localStorage.setItem('scriptlab-idb-migrated','1')}
function download(data,name,type){const u=URL.createObjectURL(new Blob([data],{type})),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),800)}
function fileSlug(text){return(text||'scriptlab').toLowerCase().replace(/[^a-z0-9]+/gi,'-')}
function exportJSON(project,analysis,calibration){download(JSON.stringify({app:'ScriptLab AI',exportedAt:new Date().toISOString(),project,analysis,calibration},null,2),fileSlug(project.title)+'.scriptlab.json','application/json')}
function exportMarkdown(project,analysis){let md='# '+project.title+'\n\n**Promesa:** '+(project.promise||'—')+'\n\n**ICN:** '+analysis.score+'/100\n';project.blocks.forEach((b,i)=>md+='\n## '+(i+1)+'. '+b.type+': '+b.label+'\n\n'+(b.content||'_Sin contenido_')+'\n'+(b.notes?'\n> Nota: '+b.notes+'\n':''));download(md,fileSlug(project.title)+'.md','text/markdown')}
function exportHTML(project,analysis){const clean=v=>String(v||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));const blocks=project.blocks.map((b,i)=>'<section><small>'+ (i+1)+'. '+clean(b.type)+'</small><h2>'+clean(b.label)+'</h2><p>'+clean(b.content).replace(/\n/g,'<br>')+'</p></section>').join('');download('<!doctype html><meta charset="utf-8"><title>'+clean(project.title)+'</title><style>body{font:16px system-ui;max-width:780px;margin:40px auto;line-height:1.6}section{border-left:4px solid #7969ff;padding:10px 20px;margin:15px 0;background:#fafafa;break-inside:avoid}small{color:#555}</style><h1>'+clean(project.title)+'</h1><p>'+clean(project.promise)+'</p><p>ICN '+analysis.score+'/100</p>'+blocks,fileSlug(project.title)+'.html','text/html')}

const T={HOOK:['Hook','#ff7d5c'],CONTEXTO:['Contexto','#69a8ff'],EVIDENCIA:['Evidencia','#ae83ff'],SEGMENTO:['Segmento','#b3bdce'],GIRO:['Giro','#f4b857'],VISUAL:['Nota visual','#32d2ac'],CTA:['CTA','#5cdb87']};
const TRASH_SVG='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M6 6l1 14h10l1-14"/></svg>';

let p,sel=null,timer,worker,rev=0,aiResult=null,aiTimer,calRecords=[],analysisDirty=true,cachedAnalysis=null,flowDirty=true,tts={index:0,playing:false,paused:false};
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)],W=t=>(t||'').trim().match(/[\p{L}\p{N}'''-]+/gu)?.length||0,D=t=>Math.round(W(t)/(p?.wpm||150)*60),time=s=>`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`,esc=s=>String(s||'').replace(/[&<>]/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[x]));

function normalizeProject(raw={}){
  const meta=raw.project||raw;
  const blocks=Array.isArray(raw.blocks)?raw.blocks:[];
  return {id:'active',title:meta.title||'Nuevo guion',promise:meta.promise||'',targetDuration:Math.max(0,Math.min(3600,Number(meta.targetDuration)||0)),aiMode:['basic','embeddings'].includes(meta.aiMode)?meta.aiMode:'basic',blocks:blocks.map((b,i)=>({id:b.id||crypto.randomUUID(),type:T[b.type]?b.type:'SEGMENTO',label:b.label||T[T[b.type]?b.type:'SEGMENTO'][0],content:b.content||'',notes:b.notes||''})),updatedAt:meta.updatedAt||Date.now(),wpm:Math.max(115,Math.min(185,Number(meta.wpm)||150))}
}

/* ===== IMPORT JSON / MD ===== */
async function importProject(){
  const input=$('#import-input');
  if(!input)return;
  input.onchange=async()=>{
    const file=input.files[0];
    if(!file)return;
    input.value='';
    const ext=file.name.split('.').pop().toLowerCase();
    try{
      if(ext==='json'){
        const text=await file.text();
        const data=JSON.parse(text);
        if(!data.project&&data.title===undefined)throw new Error('Formato JSON no reconocido.');
        const imported=normalizeProject(data.project||data);
        if(!confirm('¿Importar "'+imported.title+'"? Se reemplazará el proyecto actual.'))return;
        p=imported;sel=null;aiResult=null;flowDirty=true;markAnalysisDirty();await put('projects',p);render();
      }else if(ext==='md'){
        const text=await file.text();
        const blocks=parseMarkdownToBlocks(text);
        const titleMatch=text.match(/^#\s+(.+)/m);
        const promiseMatch=text.match(/\*\*Promesa:\*\*\s*(.+)/);
        if(!confirm('¿Importar "'+(titleMatch?titleMatch[1]:'Sin título')+'"? Se reemplazará el proyecto actual.'))return;
        p=normalizeProject({title:titleMatch?titleMatch[1].trim():'Importado',promise:promiseMatch?promiseMatch[1].trim():'',blocks,aiMode:p.aiMode,wpm:p.wpm});
        sel=null;aiResult=null;flowDirty=true;markAnalysisDirty();await put('projects',p);render();
      }else{alert('Formato no soportado. Usá .json o .md')}
    }catch(err){alert('Error al importar: '+err.message)}
  };
  input.click();
}

function parseMarkdownToBlocks(md){
  const blocks=[];
  const sections=md.split(/^##\s+/m);
  for(const section of sections){
    const m=section.match(/^(\d+)\.\s+(\w+):\s*(.+?)(?:\n\n([\s\S]*))?$/);
    if(!m)continue;
    const typeStr=m[2].toUpperCase();
    const type=T[typeStr]?typeStr:'SEGMENTO';
    let content=m[4]||'';
    content=content.replace(/^> Nota:\s*(.+)/gm,'').trim();
    const notesMatch=section.match(/^> Nota:\s*(.+)/m);
    blocks.push({id:crypto.randomUUID(),type,label:m[3].trim()||T[type][0],content,notes:notesMatch?notesMatch[1].trim():''});
  }
  return blocks;
}

async function boot(){
  await openDB();await migrateLegacy();
  calRecords=await all('calibrations');
  p=normalizeProject(await get('projects','active'));
  Object.entries(T).forEach(([k,[n,c]])=>{
    $('#palette').insertAdjacentHTML('beforeend','<button draggable="true" data-type="'+k+'"><i style="background:'+c+'"></i>'+n+'</button>');
    $('#type').insertAdjacentHTML('beforeend','<option value="'+k+'">'+n+'</option>');
  });
  bind();render();initWorker(false);
  if(typeof bindAnalysis==='function')bindAnalysis();
  if(typeof renderReferenceList==='function')renderReferenceList();
  if(typeof updateAnalysisTabState==='function')updateAnalysisTabState();
  window.ScriptLabBooted=true;
  document.documentElement.dataset.scriptlabReady='true';
}

const HEURISTICS=[
{name:'Fernández-Huerta',kind:'Validada',formula:'206.84 − 60×sílabas/palabra − 1.02×palabras/frase',source:'Fernández-Huerta (1959), adaptación española de Flesch.'},
{name:'Hook',kind:'Heurística',formula:'Longitud, pregunta y alineación con promesa',source:'Regla transparente configurable.'},
{name:'Ritmo visual',kind:'Heurística',formula:'Notas visuales y giros por duración',source:'Referencia direccional: Cutting et al. (2016).'},
{name:'CTA',kind:'Heurística',formula:'Presencia de cierre o siguiente acción',source:'Regla estructural interna.'}
];

const syllables=w=>{w=(w||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zñü]/g,'');let n=0,last=false;for(const c of w){const v='aeiouü'.includes(c);if(v&&!last)n++;last=v}return Math.max(1,n)};
const fernandezHuerta=text=>{const ws=(text||'').match(/[\p{L}]+/gu)||[],ss=(text||'').split(/[.!?]+/).filter(x=>x.trim()).length||1;if(!ws.length)return 0;return Math.max(0,Math.min(100,206.84-60*(ws.reduce((n,w)=>n+syllables(w),0)/ws.length)-1.02*(ws.length/ss)))};

function renderHeuristics(){const root=$('#heuristics-catalog');if(root)root.innerHTML=HEURISTICS.map(h=>'<article><b>'+h.name+'</b><small>'+h.kind+' · '+h.formula+'<br>'+h.source+'</small></article>').join('')}

function computeAnalysis(){
  let text=p.blocks.map(b=>b.content).join(' '),hook=p.blocks.find(b=>b.type==='HOOK'),sent=text.split(/[.!?]+/).filter(Boolean),avg=W(text)/Math.max(1,sent.length),visual=p.blocks.filter(b=>b.type==='VISUAL'||b.type==='GIRO').length,r=[];
  if(!hook)r.push(['bad','Falta un Hook']);
  if(hook&&W(hook.content)<12)r.push(['bad','Hook demasiado corto']);
  if(hook&&p.promise&&!overlap(hook.content,p.promise))r.push(['warn','La promesa no aparece en el Hook']);
  if(avg>25)r.push(['warn','Oraciones extensas']);
  if(D(text)>180&&visual<2)r.push(['warn','Ritmo visual bajo']);
  if(!p.blocks.some(b=>b.type==='CTA'))r.push(['warn','Sin CTA']);
  p.blocks.forEach(b=>{if(!b.content&&b.type!=='VISUAL')r.push(['bad',T[b.type][0]+' vacío',b.id]);if(D(b.content)>65&&['SEGMENTO','CONTEXTO'].includes(b.type))r.push(['warn','Bloque de voz largo',b.id])});
  let hs=!hook?10:Math.max(0,Math.min(100,40+(W(hook.content)>24&&W(hook.content)<86?28:0)+(overlap(hook.content,p.promise)?20:-8)));
  let fh=fernandezHuerta(text),cl=Math.max(0,Math.min(100,fh*.82-Math.max(0,avg-18)*2+18)),pa=Math.min(100,40+visual*15),pr=hook&&p.promise?(overlap(hook.content,p.promise)?82:30):30;
  let score=Math.round(hs*.31+cl*.22+pa*.22+pr*.17+(p.blocks.some(b=>b.type==='CTA')?8:0));
  const rawIcn=Math.round(Math.max(0,Math.min(100,score)));
  const recent=calRecords.slice(-5);const reference=recent.length>=5?recent.reduce((sum,x)=>sum+Number(x.apv||0),0)/recent.length:null;
  const icn=reference===null?rawIcn:Math.round(rawIcn*.7+reference*.3);
  return{hs:Math.round(hs),cl:Math.round(cl),pa:Math.round(pa),pr,score:icn,rawIcn,calibrated:reference!==null,reference:reference&&Math.round(reference),r};
}

function analysis(){if(!analysisDirty&&cachedAnalysis)return cachedAnalysis;cachedAnalysis=computeAnalysis();analysisDirty=false;return cachedAnalysis}
function markAnalysisDirty(){analysisDirty=true;cachedAnalysis=null}
function overlap(a,b){let x=new Set((a||'').toLowerCase().match(/[\p{L}]{4,}/gu)||[]),y=new Set((b||'').toLowerCase().match(/[\p{L}]{4,}/gu)||[]);return[...x].some(w=>y.has(w))}
function quality(b,a){if(!b.content&&b.type!=='VISUAL')return['Vacío','bad'];let r=a.r.find(x=>x[2]===b.id);return r?[r[0]==='bad'?'Crítico':'Revisar',r[0]]:['Óptimo','good']}

function render(){
  $('#title').value=p.title;$('#promise').value=p.promise;$('#wpm').value=p.wpm||150;$('#wpm-value').textContent=p.wpm||150;
  const durSlider=$('#target-duration');if(durSlider){durSlider.value=p.targetDuration||0;$('#target-duration-value').textContent=p.targetDuration?time(p.targetDuration):'—'}
  let a=analysis(),flow=$('#flow');
  $('#empty').hidden=!!p.blocks.length;
  if(flowDirty){
    flow.innerHTML=p.blocks.map((b,i)=>{
      let[n,c]=T[b.type],q=quality(b,a);
      return'<article draggable="true" class="flow-block '+(sel===b.id?'selected':'')+'" data-id="'+b.id+'" style="--color:'+c+'"><header>'+n+'<span>· '+(i+1)+'</span></header><h3>'+esc(b.label||n)+'</h3><textarea class="inline-block-editor" data-inline="'+b.id+'" placeholder="Pegá o escribí el contenido del bloque…">'+esc(b.content)+'</textarea><footer>'+W(b.content)+' palabras · '+D(b.content)+' s <b class="quality '+q[1]+'">'+q[0]+'</b><button class="delete-inline" data-delete="'+b.id+'" title="Eliminar bloque" aria-label="Eliminar bloque">'+TRASH_SVG+'</button></footer></article>';
    }).join('');
    bindBlocks();flowDirty=false;
  }
  renderEdit(a);renderMetrics(a);scheduleAI();renderTimeline();renderTele();draw(a);
}

function bindBlocks(){
  $$('.flow-block').forEach(e=>{
    e.onclick=event=>{if(event.target.matches('textarea,button,svg,path'))return;sel=e.dataset.id;render()};
    const text=e.querySelector('.inline-block-editor');
    if(text){const grow=()=>{text.style.height='auto';text.style.height=text.scrollHeight+'px'};grow();text.oninput=()=>{const b=p.blocks.find(x=>x.id===text.dataset.inline);if(!b)return;b.content=text.value;grow();save();renderMetrics(analysis());scheduleAI()};text.onclick=event=>event.stopPropagation()}
    const remove=e.querySelector('[data-delete]');
    if(remove)remove.onclick=event=>{event.stopPropagation();const id=remove.dataset.delete;p.blocks=p.blocks.filter(b=>b.id!==id);if(sel===id)sel=null;flowDirty=true;save();render()};
    e.ondragstart=x=>{if(x.target.matches('textarea'))return;x.dataTransfer.setData('id',e.dataset.id)};
    e.ondragover=x=>{x.preventDefault();if(!paletteDragType){e.classList.add('dragover')}};
    e.ondragleave=x=>{if(!e.contains(x.relatedTarget))e.classList.remove('dragover','dragover-top','dragover-bottom')};
    e.ondrop=x=>{x.preventDefault();const pType=x.dataTransfer.getData('palette-type');if(pType){const rect=e.getBoundingClientRect();const mid=rect.top+rect.height/2;add(pType,x.clientY<mid?e.dataset.id:null);return}let id=x.dataTransfer.getData('id'),from=p.blocks.findIndex(b=>b.id===id),to=p.blocks.findIndex(b=>b.id===e.dataset.id);if(from>=0&&to>=0&&from!==to){let[b]=p.blocks.splice(from,1);p.blocks.splice(to,0,b);flowDirty=true;save();render()}};
  });
}

function renderEdit(a){let b=p.blocks.find(x=>x.id===sel),f=$('#editor');$('#no-selection').hidden=!!b;f.hidden=!b;if(!b)return;$('#type').value=b.type;$('#label').value=b.label;$('#content').value=b.content;$('#notes').value=b.notes;$('#info').textContent=W(b.content)+' palabras · '+D(b.content)+' s · '+quality(b,a)[0]}
function renderMetrics(a){
  $('#score').textContent=a.score;$('#bar').style.width=a.score+'%';
  const blockTime=p.blocks.reduce((s,b)=>s+D(b.content),0);
  const targetTime=+(p.targetDuration||0);
  const diff=targetTime>0?targetTime-blockTime:0;
  const diffLabel=diff>0?'Faltan '+time(diff):diff<0?'Sobran '+time(Math.abs(diff)):'';
  $('#metric-grid').innerHTML=[['Hook',a.hs],['Claridad FH',a.cl],['Ritmo',a.pa],['Promesa',a.pr],['Duración',time(blockTime)],...(targetTime>0?[['Restante',diff>0?time(diff):'—',diff>0?'warn':'good']]:[]),...(aiResult?[['IA: Hook–promesa',Math.round(aiResult.alignment*100)],['IA: Redundancia',Math.round(aiResult.redundancy*100)]]:[])].map(x=>'<div>'+x[0]+'<b>'+x[1]+'</b></div>').join('');
  const baseRisks=a.r.map(x=>'<li class="'+x[0]+'">'+x[1]+'</li>').join('')||'<li class="good">Sin riesgos principales.</li>';
  const durWarn=diff>0?'<li class="warn">Faltan ~'+time(diff)+' de contenido para llegar al objetivo.</li>':'';
  const explain=aiResult?'<li class="ai-insight"><b>✦ Diagnóstico IA local activo</b>Procesó título, promesa, Hook y '+p.blocks.length+' bloque(s) dentro de este navegador. Alineación Hook–promesa: '+Math.round(aiResult.alignment*100)+'%. Redundancia máxima: '+Math.round(aiResult.redundancy*100)+'%.</li>':'<li class="ai-insight"><b>◌ Diagnóstico IA no activo</b>Se usan reglas de estructura, duración, claridad y ritmo.</li>';
  $('#risks').innerHTML=(durWarn?durWarn:'')+baseRisks+explain;renderHeuristics();
}
function renderTimeline(){let s=0;$('#timeline-list').innerHTML=p.blocks.map((b,i)=>{let t=s;s+=D(b.content);return'<div class="timeline-item"><small>'+time(t)+'</small><i class="dot" style="background:'+T[b.type][1]+'"></i><button data-go="'+b.id+'">'+(i+1)+'. '+esc(b.label||T[b.type][0])+'</button><small>'+D(b.content)+'s</small></div>'}).join('');$$('[data-go]').forEach(x=>x.onclick=()=>{sel=x.dataset.go;view('canvas');render()})}
function renderTele(){$('#teletext').innerHTML=p.blocks.filter(b=>b.content).map(b=>'<section class="tele-section"><small>'+T[b.type][0]+'</small><p>'+esc(b.content)+'</p></section>').join('')||'<p>Sin contenido para leer.</p>'}
function draw(a){let c=$('#chart'),x=c.getContext('2d'),w=c.width,h=c.height;x.clearRect(0,0,w,h);x.strokeStyle='#303b53';for(let y=35;y<h;y+=40){x.beginPath();x.moveTo(30,y);x.lineTo(w-10,y);x.stroke()}x.strokeStyle='#32d2ac';x.lineWidth=3;x.beginPath();x.moveTo(30,18);x.bezierCurveTo(100,55,130,60+(100-a.hs)/2,180,70);x.bezierCurveTo(300,95,380,100+(100-a.pa)/3,w-12,h-a.score*1.5);x.stroke();x.fillStyle='#9aa8c0';x.font='11px sans-serif';x.fillText('ICN '+a.score+'/100',35,17)}
function renderCal(){all('calibrations').then(rows=>{$('#caldata').innerHTML=rows.length?rows.map(r=>'<p>'+r.format+' · '+r.genre+': <b>'+r.apv+'%</b></p>').join(''):'<small>Sin datos todavía.</small>'})}

function save(){markAnalysisDirty();clearTimeout(timer);timer=setTimeout(async()=>{p.title=$('#title').value||'Nuevo guion';p.promise=$('#promise').value;p.updatedAt=Date.now();await put('projects',p);if(Date.now()-(p.lastSnapshotAt||0)>1800000){p.lastSnapshotAt=Date.now();await put('snapshots',{id:crypto.randomUUID(),projectId:p.id,createdAt:p.lastSnapshotAt,data:structuredClone(p)})}},350)}
function add(type='HOOK',insertBefore=null){const block={id:crypto.randomUUID(),type,label:T[type][0],content:'',notes:''};if(insertBefore!=null){const idx=p.blocks.findIndex(b=>b.id===insertBefore);if(idx>=0)p.blocks.splice(idx,0,block);else p.blocks.push(block)}else{p.blocks.push(block)}flowDirty=true;sel=block.id;save();render()}
function move(n){let i=p.blocks.findIndex(b=>b.id===sel),j=i+n;if(j>=0&&j<p.blocks.length){[p.blocks[i],p.blocks[j]]=[p.blocks[j],p.blocks[i]];flowDirty=true;save();render()}}
function view(id){$$('.panel').forEach(x=>x.classList.toggle('on',x.id===id));$$('.view').forEach(x=>x.classList.toggle('on',x.dataset.view===id))}

async function downloadModel(){
  const status=$('#model-download-status'),progress=$('#model-download-progress');
  progress.hidden=false;progress.value=5;status.textContent='Preparando descarga local…';
  await initWorker(true);progress.value=100;status.textContent='✓ Modelo listo en este navegador.';
}

function contentHash(value){let h=2166136261;for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,16777619)}return(h>>>0).toString(36)}

function scheduleAI(){
  clearTimeout(aiTimer);
  if(p.aiMode!=='embeddings'||!worker)return;
  aiTimer=setTimeout(async()=>{
    const texts=[{id:'title',text:p.title,role:'title'},{id:'promise',text:p.promise,role:'promise'},...p.blocks.map(b=>({id:b.id,text:b.content,role:'block'}))];
    const hook=p.blocks.find(b=>b.type==='HOOK');if(hook)texts.push({id:'hook',text:hook.content,role:'hook'});
    const id='embedding-'+contentHash(JSON.stringify(texts));const cached=await get('analysisCache',id);
    if(cached?.result){aiResult=cached.result;setAIActivity('semantic','✦ IA: caché');renderMetrics(analysis());return}
    worker.postMessage({type:'EMBED',requestId:++rev,cacheId:id,texts});
  },700);
}

function setAIActivity(kind,text){const el=$('#ai-activity');if(!el)return;el.className='ai-activity '+kind;el.textContent=text;el.title=text}

async function initWorker(activate=false){
  worker?.terminate();
  $('#ai-state').textContent=p.aiMode==='basic'?'Heurísticas locales':'Modelo local listo';
  setAIActivity(p.aiMode==='basic'?'heuristic':'loading',p.aiMode==='basic'?'◌ IA':'◌ IA: preparando…');
  if(p.aiMode==='basic'||!activate)return;
  return new Promise((resolve,reject)=>{try{
    worker=new Worker('./ai-worker.js',{type:'module'});
    worker.onmessage=event=>{const d=event.data;
      if(d.type==='PROGRESS'){setAIActivity('loading','◌ IA: '+d.message);const pct=Number((d.message.match(/(\d+)%/)||[])[1]);if(Number.isFinite(pct)){$('#model-download-progress').hidden=false;$('#model-download-progress').value=pct}}
      if(d.type==='READY'){setAIActivity('semantic','✦ IA: listo');if(typeof updateAnalysisTabState==='function')updateAnalysisTabState();resolve()}
      if(d.type==='EMBED_RESULT'){aiResult=d;put('analysisCache',{id:d.cacheId||'embedding-'+Date.now(),projectId:p.id,updatedAt:Date.now(),result:d});setAIActivity('semantic','✦ IA: '+p.blocks.length+' bloques');renderMetrics(analysis())}
      if(d.type==='ERROR'){setAIActivity('error','! IA: error');reject(new Error(d.message))}
      if(typeof handleWorkerResult==='function')handleWorkerResult(d);
    };
    worker.postMessage({type:'INIT',mode:p.aiMode,revision:++rev});
  }catch(error){reject(error)}})
}

function bind(){
  /* Palette drag — drops between blocks */
  $$('#palette [data-type]').forEach(button=>button.addEventListener('dragstart',event=>{event.dataTransfer.setData('palette-type',button.dataset.type);event.dataTransfer.effectAllowed='copy'}));
  let paletteDragType=null;
  document.addEventListener('dragstart',e=>{if(e.target.closest('#palette')){paletteDragType=e.target.closest('#palette [data-type]')?.dataset.type||null}});
  document.addEventListener('dragend',()=>{paletteDragType=null;$$('.flow-block').forEach(e=>e.classList.remove('dragover-top','dragover-bottom'))});
  $('#viewport').ondragover=e=>{e.preventDefault();if(paletteDragType){const block=e.target.closest('.flow-block');if(block){const rect=block.getBoundingClientRect();const mid=rect.top+rect.height/2;block.classList.toggle('dragover-top',e.clientY<mid);block.classList.toggle('dragover-bottom',e.clientY>=mid)}else{$$('.flow-block').forEach(e=>e.classList.remove('dragover-top','dragover-bottom'))}}};
  $('#viewport').ondragleave=e=>{if(!e.relatedTarget||!$('#viewport').contains(e.relatedTarget))$$('.flow-block').forEach(el=>el.classList.remove('dragover-top','dragover-bottom'))};
  $('#viewport').ondrop=e=>{e.preventDefault();const t=e.dataTransfer.getData('palette-type')||e.dataTransfer.getData('type');if(!t)return;const block=e.target.closest('.flow-block');if(block){const rect=block.getBoundingClientRect();const mid=rect.top+rect.height/2;add(t,e.clientY<mid?block.dataset.id:null)}else{add(t)}};

  $('#title').oninput=save;
  $('#wpm').oninput=()=>{p.wpm=+$('#wpm').value;$('#wpm-value').textContent=p.wpm;save();render()};
  $('#target-duration').oninput=()=>{const v=+$('#target-duration').value;p.targetDuration=v;$('#target-duration-value').textContent=v?time(v):'—';save();renderMetrics(analysis())};
  $('#promise').oninput=()=>{save();renderMetrics(analysis())};
  ['type','label','content','notes'].forEach(k=>$('#'+k).oninput=()=>{let b=p.blocks.find(x=>x.id===sel);if(!b)return;b[k]=$('#'+k).value;save();render()});
  $('#del').onclick=()=>{p.blocks=p.blocks.filter(b=>b.id!==sel);sel=null;flowDirty=true;save();render()};
  $('#up').onclick=()=>move(-1);$('#down').onclick=()=>move(1);

  /* Navigation */
  $$('.view').forEach(b=>b.onclick=()=>view(b.dataset.view));
  $$('.tab').forEach(b=>b.onclick=()=>{$$('.tab').forEach(x=>x.classList.toggle('on',x===b));$$('.tabpage').forEach(x=>x.classList.toggle('on',x.id===b.dataset.tab));if(b.dataset.tab==='cal')renderCal()});

  /* New */
  $('#new').onclick=()=>{if(!confirm('¿Crear un proyecto nuevo? Exportá el actual si querés conservarlo.'))return;p={id:'active',title:'Nuevo guion',promise:'',targetDuration:0,format:'long',genre:'educativo',aiMode:'basic',wpm:150,blocks:[],updatedAt:Date.now()};sel=null;aiResult=null;flowDirty=true;markAnalysisDirty();save();render()};

  /* Export */
  $('#export').onclick=()=>{const menu=$('#export-menu');menu.hidden=!menu.hidden;$('#export').setAttribute('aria-expanded',String(!menu.hidden))};
  $$('[data-export]').forEach(button=>button.onclick=async()=>{const a=analysis(),c=await all('calibrations'),kind=button.dataset.export;if(kind==='md')exportMarkdown(p,a);else if(kind==='html')exportHTML(p,a);else exportJSON(p,a,c);$('#export-menu').hidden=true});

  /* Import */
  $('#import-btn').onclick=importProject;

  /* Theme */
  $('#theme').onclick=()=>document.body.classList.toggle('light');

  /* Panel toggles */
  const syncPanels=()=>{const l=document.body.classList.contains('left-collapsed'),r=document.body.classList.contains('right-collapsed');$('#toggle-left').classList.toggle('active',l);$('#toggle-right').classList.toggle('active',r)};
  $('#toggle-left').onclick=()=>{document.body.classList.toggle('left-collapsed');syncPanels()};
  $('#toggle-right').onclick=()=>{document.body.classList.toggle('right-collapsed');syncPanels()};
  syncPanels();

  /* AI dialog */
  const downloadButton=$('#download-model');
  const paintMode=()=>{const ai=p.aiMode==='embeddings';$('#mode-basic').classList.toggle('active',!ai);$('#mode-ai').classList.toggle('active',ai);$('#ai-download-area').hidden=!ai;$('#basic-state').hidden=ai};
  $('#mode-basic').onclick=()=>{p.aiMode='basic';aiResult=null;initWorker(false);save();paintMode();if(typeof updateAnalysisTabState==='function')updateAnalysisTabState()};
  $('#mode-ai').onclick=()=>{p.aiMode='embeddings';paintMode()};
  if(downloadButton)downloadButton.onclick=async event=>{event.preventDefault();downloadButton.disabled=true;try{await downloadModel();save()}catch(error){$('#model-download-status').textContent='No se pudo descargar el modelo.';console.error(error)}finally{downloadButton.disabled=false}};
  $('#ai').onclick=()=>{const dialog=$('#aidialog');paintMode();if(typeof dialog.showModal==='function')dialog.showModal();else{dialog.setAttribute('open','');dialog.style.display='block'}};
  $('#close-ai').onclick=()=>$('#aidialog').close?.();

  /* Calibration */
  $('#calform').onsubmit=async e=>{e.preventDefault();await put('calibrations',{id:crypto.randomUUID(),format:$('#format').value,genre:$('#genre').value,apv:+$('#apv').value,r30:+$('#r30').value||null,createdAt:Date.now()});e.target.reset();calRecords=await all('calibrations');renderCal();renderMetrics(analysis())};

  /* Teleprompter */
  const speakAt=i=>{const list=p.blocks.filter(b=>b.content);if(!list.length)return;tts.index=Math.max(0,Math.min(i,list.length-1));speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(list[tts.index].content);u.lang='es-AR';u.rate=+$('#rate').value;tts.playing=true;u.onend=()=>{if(tts.playing&&tts.index<list.length-1)speakAt(tts.index+1)};speechSynthesis.speak(u)};
  $('#speak').onclick=()=>{if(tts.paused){speechSynthesis.resume();tts.paused=false}else speakAt(tts.index)};
  $('#pause-speak').onclick=()=>{if(tts.playing){speechSynthesis.pause();tts.paused=true}};
  $('#prev-speak').onclick=()=>speakAt(tts.index-1);
  $('#next-speak').onclick=()=>speakAt(tts.index+1);
  $('#full').onclick=()=>$('#tele').requestFullscreen();

  /* Service worker */
  if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js?v=13');
}

/* ====================================================================
   SCRIPTLAB ANÁLISIS IA — Fases 1 y 2
   ==================================================================== */

let densityChartInstance = null;
let analysisRequestId = 0;
const analysisCallbacks = {};

const PREDEFINED_TOPICS = [
  { label: 'Gancho (Hook)', text: 'Una apertura que captura inmediatamente la atención del espectador con una pregunta, dato sorprendente o promesa clara' },
  { label: 'Problema', text: 'La descripción de un problema, dolor o necesidad que enfrenta la audiencia' },
  { label: 'Contexto', text: 'Información de fondo y contexto necesario para entender el tema principal' },
  { label: 'Evidencia', text: 'Datos, estadísticas, ejemplos concretos, estudios o testimonios que respaldan las afirmaciones' },
  { label: 'Solución', text: 'La propuesta de solución al problema planteado, explicada paso a paso' },
  { label: 'Giro narrativo', text: 'Un cambio inesperado en la dirección del relato que sorprende o recontextualiza lo anterior' },
  { label: 'Llamada a la acción (CTA)', text: 'Una instrucción clara sobre qué debe hacer el espectador después: suscribirse, comentar, visitar un enlace' },
  { label: 'Resumen o cierre', text: 'Un repaso de los puntos principales o una conclusión que refuerza el mensaje central' }
];

function splitSentences(text) {
  if (!text) return [];
  const raw = text.split(/(?<=[.!?])\s+/);
  return raw.map(s => s.trim()).filter(s => s.length > 10);
}

function splitIntoSegments(text, wpm) {
  const wordsPerMinute = wpm || p?.wpm || 150;
  const segments = [];
  const words = (text || '').split(/\s+/).filter(Boolean);
  const wordsPerSegment = Math.ceil(wordsPerMinute);
  for (let i = 0; i < words.length; i += wordsPerSegment) {
    segments.push({ text: words.slice(i, i + wordsPerSegment).join(' '), label: 'Min ' + (Math.floor(i / wordsPerMinute) + 1) });
  }
  return segments.length ? segments : [{ text: text || '', label: 'Min 1' }];
}

function workerSend(type, data) {
  if (!worker) { alert('Activá el modo AI primero (Configurar IA > Modo AI > Descargar modelo).'); return null; }
  const id = ++analysisRequestId;
  return new Promise((resolve, reject) => {
    analysisCallbacks[id] = { resolve, reject };
    worker.postMessage({ type, requestId: id, ...data });
  });
}

function handleWorkerResult(d) {
  const cb = analysisCallbacks[d.requestId];
  if (!cb) return;
  if (d.type === 'ERROR') { cb.reject(new Error(d.message)); delete analysisCallbacks[d.requestId]; return; }
  cb.resolve(d);
  delete analysisCallbacks[d.requestId];
}

function updateAnalysisTabState() {
  const isAI = p?.aiMode === 'embeddings' && worker;
  const notice = $('#analysis-notice');
  const content = $('#analysis-content');
  if (notice) notice.hidden = isAI;
  if (content) content.hidden = !isAI;
}

/* ACTUALIZACIÓN 1 — Resumen Extractivo */
function runExtractive() {
  const fullText = p.blocks.map(b => b.content).join(' ');
  if (!fullText.trim()) { $('#extractive-results').innerHTML = '<small>El guion no tiene contenido.</small>'; return; }
  const sentences = splitSentences(fullText);
  if (sentences.length < 3) { $('#extractive-results').innerHTML = '<small>Necesitás al menos 3 oraciones.</small>'; return; }
  const topN = Math.min(+$('#extract-topN').value || 5, sentences.length);
  const btn = $('#run-extractive'); btn.disabled = true; btn.textContent = 'Procesando…';
  workerSend('EXTRACT_KEY_SENTENCES', { sentences, fullText, topN })
    .then(result => {
      $('#extractive-results').innerHTML = result.sentences.map(s =>
        '<div class="key-sentence">' + esc(s.text) + '<br><span class="score-badge">Relevancia: ' + Math.round(s.score * 100) + '%</span></div>'
      ).join('');
      highlightKeySentences(result.sentences.map(s => s.text));
    })
    .catch(err => { $('#extractive-results').innerHTML = '<small class="bad">Error: ' + esc(err.message) + '</small>'; })
    .finally(() => { btn.disabled = false; btn.textContent = 'Analizar'; });
}

function highlightKeySentences(keyTexts) {
  const keySet = new Set(keyTexts.map(t => t.trim().substring(0, 60)));
  $$('.flow-block').forEach(el => {
    const content = el.querySelector('.inline-block-editor');
    if (!content) return;
    const text = content.value.trim();
    const isKey = keyTexts.some(kt => text.includes(kt.trim().substring(0, 60)));
    el.classList.toggle('highlighted', isKey);
  });
}

/* ACTUALIZACIÓN 2 — Redundancia Global */
function runRedundancy() {
  const blocks = p.blocks.map(b => b.content).filter(t => t.trim().length > 10);
  if (blocks.length < 2) { $('#redundancy-results').innerHTML = '<small>Necesitás al menos 2 bloques con contenido.</small>'; return; }
  const threshold = +($('#redundancy-threshold').value || 0.85);
  const btn = $('#run-redundancy'); btn.disabled = true; btn.textContent = 'Procesando…';
  workerSend('COMPUTE_REDUNDANCY', { blocks, threshold })
    .then(result => {
      const pct = result.totalPairs > 0 ? Math.round(result.redundantCount / result.totalPairs * 100) : 0;
      let html = '<div class="redundancy-stat">' +
        '<div class="stat-card"><div class="val">' + Math.round(result.density * 100) + '%</div><div class="lbl">Densidad semántica</div></div>' +
        '<div class="stat-card"><div class="val">' + result.redundantCount + '</div><div class="lbl">Pares redundantes (>' + threshold + ')</div></div></div>';
      if (result.redundantPairs.length) {
        html += '<p style="font-size:11px;color:var(--muted);margin:8px 0 4px">Pares con alta similitud:</p>';
        result.redundantPairs.slice(0, 8).forEach(pair => {
          html += '<div class="redundancy-pair"><span class="sim-tag high">' + Math.round(pair.similarity * 100) + '%</span>' +
            '<blockquote>' + esc(pair.textA.substring(0, 120)) + '</blockquote>' +
            '<blockquote>' + esc(pair.textB.substring(0, 120)) + '</blockquote></div>';
        });
      } else {
        html += '<small style="color:var(--good)">No se detectaron pares redundantes. Buena densidad semántica.</small>';
      }
      $('#redundancy-results').innerHTML = html;
    })
    .catch(err => { $('#redundancy-results').innerHTML = '<small class="bad">Error: ' + esc(err.message) + '</small>'; })
    .finally(() => { btn.disabled = false; btn.textContent = 'Analizar'; });
}

/* ACTUALIZACIÓN 3 — Densidad Temática por Minuto */
function runDensity() {
  const fullText = p.blocks.map(b => b.content).join(' ');
  if (!fullText.trim()) { $('#density-results').innerHTML = '<small>El guion no tiene contenido.</small>'; return; }
  const segments = splitIntoSegments(fullText, p.wpm);
  const btn = $('#run-density'); btn.disabled = true; btn.textContent = 'Procesando…';
  workerSend('COMPUTE_DENSITY', { segments, fullText })
    .then(result => {
      let html = '<div class="density-header"><span class="density-value">' + result.topicsPerMinute + '</span><span class="density-unit">temas estimados por minuto</span></div>';
      html += '<div style="font-size:11px;color:var(--muted);margin:4px 0">Densidad global: ' + Math.round(result.density * 100) + '% · ' + result.totalSegments + ' segmentos</div>';
      if (result.changes.length) {
        html += '<div class="density-changes">';
        result.changes.forEach(c => { html += '<div class="density-change">Cambio temático después del segmento ' + c.afterSegment + ' (similitud: ' + Math.round(c.similarity * 100) + '%)</div>'; });
        html += '</div>';
      }
      $('#density-results').innerHTML = html;
      renderDensityChart(result);
    })
    .catch(err => { $('#density-results').innerHTML = '<small class="bad">Error: ' + esc(err.message) + '</small>'; })
    .finally(() => { btn.disabled = false; btn.textContent = 'Analizar'; });
}

function renderDensityChart(result) {
  const canvas = $('#density-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (densityChartInstance) { densityChartInstance.destroy(); densityChartInstance = null; }
  const ctx = canvas.getContext('2d');
  const labels = result.segments.map(s => s.label);
  const data = result.segments.map(s => Math.round(s.globalSim * 100));
  const avgLine = result.segments.map(() => Math.round(result.avgGlobalSim * 100));
  densityChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Similitud con global (%)', data, backgroundColor: 'rgba(121,105,255,0.6)', borderColor: '#7969ff', borderWidth: 1, borderRadius: 4 },
        { label: 'Promedio', data: avgLine, type: 'line', borderColor: '#f4b857', borderDash: [4, 4], pointRadius: 0, borderWidth: 1, fill: false }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { min: 0, max: 100, ticks: { color: '#9aa8c0', font: { size: 10 } }, grid: { color: '#303b53' } }, x: { ticks: { color: '#9aa8c0', font: { size: 9 } }, grid: { display: false } } },
      plugins: { legend: { labels: { color: '#9aa8c0', font: { size: 10 } } } }
    }
  });
}

/* ACTUALIZACIÓN 4 — Comparación A/B Semántica */
function populateCompareTargets() {
  const sel = $('#compare-source'), target = $('#compare-target');
  if (!sel || !target) return;
  const source = sel.value;
  target.innerHTML = '<option value="">— Seleccioná —</option>';
  if (source === 'snapshot') {
    all('snapshots').then(snaps => { snaps.sort((a, b) => b.createdAt - a.createdAt); snaps.slice(0, 20).forEach(s => { target.insertAdjacentHTML('beforeend', '<option value="snapshot:' + s.id + '">' + esc(s.data?.title || 'Sin título') + ' (' + new Date(s.createdAt).toLocaleDateString('es') + ')</option>'); }); });
  } else if (source === 'reference') {
    all('references').then(refs => { refs.forEach(r => { target.insertAdjacentHTML('beforeend', '<option value="reference:' + r.id + '">' + esc(r.title || r.channel || 'Referente') + '</option>'); }); });
  }
}

function runCompare() {
  const val = ($('#compare-target') || {}).value || '';
  if (!val) { alert('Seleccioná un objetivo para comparar.'); return; }
  const [kind, id] = val.split(':');
  const script1 = p.blocks.map(b => b.content).join(' ');
  const btn = $('#run-compare'); btn.disabled = true; btn.textContent = 'Procesando…';
  const doCompare = (script2, label2) => {
    workerSend('COMPARE_SCRIPTS', { script1, script2 })
      .then(result => {
        let html = '<div class="compare-global"><div class="sim-value">' + Math.round(result.globalSimilarity * 100) + '%</div><div><div style="font-size:13px;font-weight:700;color:var(--text)">' + esc(p.title || 'Guion actual') + ' vs. ' + esc(label2) + '</div><div class="sim-interpretation">' + esc(result.interpretation) + '</div></div></div>';
        $('#compare-results').innerHTML = html;
      })
      .catch(err => { $('#compare-results').innerHTML = '<small class="bad">Error: ' + esc(err.message) + '</small>'; })
      .finally(() => { btn.disabled = false; btn.textContent = 'Comparar'; });
  };
  if (kind === 'snapshot') {
    get('snapshots', id).then(snap => { if (!snap?.data?.blocks) { alert('Snapshot no encontrada.'); btn.disabled = false; btn.textContent = 'Comparar'; return; } doCompare(snap.data.blocks.map(b => b.content).join(' '), snap.data.title || 'Versión guardada'); });
  } else if (kind === 'reference') {
    get('references', id).then(ref => { if (!ref?.transcript) { alert('Referente no encontrada.'); btn.disabled = false; btn.textContent = 'Comparar'; return; } doCompare(ref.transcript, ref.title || 'Referente'); });
  }
}

/* ACTUALIZACIÓN 5 — Detección de Huecos */
function populateGapRefTargets() {
  const sel = $('#gap-ref-target');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Ninguno —</option>';
  all('references').then(refs => { refs.forEach(r => { sel.insertAdjacentHTML('beforeend', '<option value="' + r.id + '">' + esc(r.title || r.channel || 'Referente') + '</option>'); }); });
}

function runGaps() {
  const blocks = p.blocks.map(b => b.content).filter(t => t.trim());
  if (blocks.length < 1) { $('#gap-results').innerHTML = '<small>El guion no tiene contenido.</small>'; return; }
  const useRef = $('#gap-use-ref')?.checked;
  const refId = $('#gap-ref-target')?.value;
  const btn = $('#run-gaps'); btn.disabled = true; btn.textContent = 'Procesando…';
  if (useRef && refId) {
    get('references', refId).then(ref => {
      if (!ref?.transcript) { $('#gap-results').innerHTML = '<small>Referente no encontrada.</small>'; btn.disabled = false; btn.textContent = 'Analizar'; return; }
      const refBlocks = splitSentences(ref.transcript);
      workerSend('COMPUTE_REF_GAPS', { scriptBlocks: blocks, refBlocks, threshold: 0.5 })
        .then(result => {
          let html = '<div class="refgap-section"><h4>Temas del referente que faltan en tu guion</h4>';
          if (!result.missingInScript.length) { html += '<small style="color:var(--good)">Tu guion cubre todos los temas principales del referente.</small>'; }
          else { result.missingInScript.slice(0, 10).forEach(f => { html += '<div class="refgap-fragment">' + esc(f.text.substring(0, 150)) + '<span class="sim-mini">' + Math.round(f.maxSimilarity * 100) + '%</span></div>'; }); }
          html += '</div><div class="refgap-section"><h4>Temas únicos de tu guion</h4>';
          if (!result.uniqueToScript.length) { html += '<small style="color:var(--muted)">Sin contenido único.</small>'; }
          else { result.uniqueToScript.slice(0, 10).forEach(f => { html += '<div class="refgap-fragment">' + esc(f.text.substring(0, 150)) + '<span class="sim-mini">' + Math.round(f.maxSimilarity * 100) + '%</span></div>'; }); }
          html += '</div>'; $('#gap-results').innerHTML = html;
        })
        .catch(err => { $('#gap-results').innerHTML = '<small class="bad">Error: ' + esc(err.message) + '</small>'; })
        .finally(() => { btn.disabled = false; btn.textContent = 'Analizar'; });
    });
  } else {
    const topics = PREDEFINED_TOPICS.map(t => ({ label: t.label, text: t.text }));
    workerSend('DETECT_GAPS', { blocks, topics, threshold: 0.55 })
      .then(result => {
        let html = '<div class="gaps-list">';
        result.gaps.forEach(g => { html += '<div class="gap-item"><div class="gap-topic">' + esc(g.topic) + '</div><small>Similitud máxima: ' + Math.round(g.maxSimilarity * 100) + '%</small></div>'; });
        result.covered.forEach(g => { html += '<div class="gap-item covered"><div class="gap-topic">' + esc(g.topic) + '</div><small>Cubierto (' + Math.round(g.maxSimilarity * 100) + '%)</small></div>'; });
        html += '</div>'; $('#gap-results').innerHTML = html;
      })
      .catch(err => { $('#gap-results').innerHTML = '<small class="bad">Error: ' + esc(err.message) + '</small>'; })
      .finally(() => { btn.disabled = false; btn.textContent = 'Analizar'; });
  }
}

/* ACTUALIZACIÓN 8 — Huecos vs. Referente */
function populateRefGapTargets() {
  const sel = $('#refgap-target');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Seleccioná —</option>';
  all('references').then(refs => { refs.forEach(r => { sel.insertAdjacentHTML('beforeend', '<option value="' + r.id + '">' + esc(r.title || r.channel || 'Referente') + '</option>'); }); });
}

function runRefGaps() {
  const refId = ($('#refgap-target') || {}).value;
  if (!refId) { alert('Seleccioná un referente.'); return; }
  const blocks = p.blocks.map(b => b.content).filter(t => t.trim());
  if (!blocks.length) { $('#refgap-results').innerHTML = '<small>El guion no tiene contenido.</small>'; return; }
  const threshold = +($('#refgap-threshold')?.value || 0.5);
  const btn = $('#run-refgaps'); btn.disabled = true; btn.textContent = 'Procesando…';
  get('references', refId).then(ref => {
    if (!ref?.transcript) { $('#refgap-results').innerHTML = '<small>Referente no encontrada.</small>'; btn.disabled = false; btn.textContent = 'Analizar'; return; }
    const refBlocks = splitSentences(ref.transcript);
    workerSend('COMPUTE_REF_GAPS', { scriptBlocks: blocks, refBlocks, threshold })
      .then(result => {
        let html = '<p style="font-size:11px;color:var(--muted);margin:4px 0">' + result.totalScriptBlocks + ' bloques vs. ' + result.totalRefBlocks + ' fragmentos del referente.</p>';
        html += '<div class="refgap-section"><h4>Falta en tu guion</h4>';
        if (!result.missingInScript.length) { html += '<small style="color:var(--good)">Cubre los temas del referente.</small>'; }
        else { result.missingInScript.slice(0, 12).forEach(f => { html += '<div class="refgap-fragment">' + esc(f.text.substring(0, 160)) + '<span class="sim-mini">' + Math.round(f.maxSimilarity * 100) + '%</span></div>'; }); }
        html += '</div><div class="refgap-section"><h4>Único en tu guion</h4>';
        if (!result.uniqueToScript.length) { html += '<small style="color:var(--muted)">Sin contenido único.</small>'; }
        else { result.uniqueToScript.slice(0, 8).forEach(f => { html += '<div class="refgap-fragment">' + esc(f.text.substring(0, 160)) + '<span class="sim-mini">' + Math.round(f.maxSimilarity * 100) + '%</span></div>'; }); }
        html += '</div>'; $('#refgap-results').innerHTML = html;
      })
      .catch(err => { $('#refgap-results').innerHTML = '<small class="bad">Error: ' + esc(err.message) + '</small>'; })
      .finally(() => { btn.disabled = false; btn.textContent = 'Analizar'; });
  });
}

/* ====================================================================
   BIBLIOTECA DE REFERENCIA — YouTube
   ==================================================================== */
function extractVideoId(url) {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

const CORS_PROXIES = [
  url => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
  url => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url)
];

async function fetchYouTubeTranscript(videoId) {
  const ft = (url, ms) => fetch(url, { signal: AbortSignal.timeout(ms) });

  /* ── MÉTODO 1: API pública de Vercel ── */
  try {
    const resp = await ft('https://youtube-transcript-api-tau-one.vercel.app/transcript?videoId=' + videoId, 12000);
    if (resp.ok) {
      const data = await resp.json();
      if (Array.isArray(data?.transcript) && data.transcript.length > 0) {
        const text = data.transcript.map(t => t.text || t.content || '').filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        if (text.length > 20) {
          return { transcript: text, title: data.title || data.videoDetails?.title || 'Sin título', channel: data.channel || data.videoDetails?.author || 'Canal desconocido', language: data.language || 'es' };
        }
      }
      /* Algunas APIs devuelven { transcript: "texto completo" } */
      if (typeof data?.transcript === 'string' && data.transcript.length > 20) {
        return { transcript: data.transcript, title: data.title || 'Sin título', channel: data.channel || 'Canal desconocido', language: data.language || 'es' };
      }
    }
  } catch (_) {}

  /* ── MÉTODO 2: TimedText directo de YouTube (caption URLs suelen permitir CORS) ── */
  for (const proxy of CORS_PROXIES) {
    let captionUrl = null, title = 'Sin título', channel = 'Canal desconocido', lang = 'es';
    try {
      /* Obtener caption tracks vía get_video_info */
      const gviUrl = 'https://www.youtube.com/get_video_info?video_id=' + videoId + '&html5=1';
      const resp = await ft(proxy(gviUrl), 12000);
      if (!resp.ok) continue;
      const raw = await resp.text();
      const pr = JSON.parse(new URLSearchParams(raw).get('player_response') || '{}');
      const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!tracks?.length) continue;
      const track = tracks.find(t => t.languageCode === 'es') || tracks.find(t => t.languageCode?.startsWith('es')) || tracks[0];
      captionUrl = track.baseUrl;
      title = pr?.videoDetails?.title || title;
      channel = pr?.videoDetails?.author || channel;
      lang = track.languageCode;
    } catch (_) { continue; }
    if (!captionUrl) continue;

    /* Descargar XML: primero directo (YouTube caption URLs suelen tener CORS), luego proxy */
    const cProxies = [u => u, ...CORS_PROXIES];
    for (const cp of cProxies) {
      try {
        const cr = await ft(cp(captionUrl), 10000);
        if (!cr.ok) continue;
        const xml = await cr.text();
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        if (doc.querySelector('parsererror')) continue;
        const lines = [];
        doc.querySelectorAll('text').forEach(t => lines.push(t.textContent.replace(/\n/g, ' ').trim()));
        if (!lines.length) continue;
        return { transcript: lines.join(' ').replace(/\s+/g, ' ').trim(), title, channel, language: lang };
      } catch (_) { continue; }
    }
  }

  /* ── MÉTODO 3: Scraping del HTML de la página ── */
  for (const proxy of CORS_PROXIES) {
    try {
      const resp = await ft(proxy('https://www.youtube.com/watch?v=' + videoId), 15000);
      if (!resp.ok) continue;
      const html = await resp.text();
      const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
      if (!match) continue;
      const pr = JSON.parse(match[1]);
      const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!tracks?.length) continue;
      const track = tracks.find(t => t.languageCode === 'es') || tracks.find(t => t.languageCode?.startsWith('es')) || tracks[0];
      /* Probar caption URL directo y por proxy */
      for (const cp of [u => u, ...CORS_PROXIES]) {
        try {
          const cr = await ft(cp(track.baseUrl), 10000);
          if (!cr.ok) continue;
          const xml = await cr.text();
          const doc = new DOMParser().parseFromString(xml, 'text/xml');
          if (doc.querySelector('parsererror')) continue;
          const lines = [];
          doc.querySelectorAll('text').forEach(t => lines.push(t.textContent.replace(/\n/g, ' ').trim()));
          if (!lines.length) continue;
          return { transcript: lines.join(' ').replace(/\s+/g, ' ').trim(), title: pr?.videoDetails?.title || 'Sin título', channel: pr?.videoDetails?.author || 'Canal desconocido', language: track.languageCode };
        } catch (_) { continue; }
      }
    } catch (_) { continue; }
  }

  throw new Error('No se pudieron obtener los subtítulos. Probá con "Pegar transcripción manualmente".');
}

async function addReference() {
  const input = $('#youtube-url');
  const url = (input?.value || '').trim();
  if (!url) return;
  const videoId = extractVideoId(url);
  if (!videoId) { $('#ref-status').textContent = 'URL de YouTube no válida.'; return; }
  const btn = $('#add-reference');
  const progress = $('#ref-progress');
  const status = $('#ref-status');
  btn.disabled = true; progress.hidden = false; progress.value = 10;
  status.textContent = 'Extrayendo transcripción…';
  try {
    const info = await fetchYouTubeTranscript(videoId);
    progress.value = 50; status.textContent = 'Guardando…';
    const truncated = info.transcript.substring(0, 1500);
    let embedding = null;
    if (worker && p.aiMode === 'embeddings') {
      status.textContent = 'Generando embedding…';
      const result = await workerSend('EMBED_TEXTS', { texts: [{ id: 'ref', text: truncated }] });
      embedding = result.embeddings?.ref ? new Float32Array(result.embeddings.ref) : null;
    }
    await put('references', {
      id: crypto.randomUUID(), url, videoId,
      title: info.title, channel: info.channel, language: info.language,
      transcript: info.transcript, transcriptTruncated: truncated,
      embedding, createdAt: Date.now()
    });
    progress.value = 100; status.textContent = '✓ ' + info.title;
    input.value = ''; renderReferenceList();
    populateCompareTargets(); populateGapRefTargets(); populateRefGapTargets();
    all('references').then(refs => { const sec = $('#ref-gap-section'); if (sec) sec.hidden = refs.length === 0; });
  } catch (err) {
    status.textContent = 'Error: ' + err.message; progress.value = 0;
  } finally {
    btn.disabled = false;
    setTimeout(() => { progress.hidden = true; }, 2000);
  }
}

async function addManualReference() {
  const titleInput = document.getElementById('paste-ref-title');
  const textArea = document.getElementById('paste-ref-text');
  const status = document.getElementById('ref-status');
  const text = (textArea?.value || '').trim();
  if (!text || text.length < 20) { if (status) status.textContent = 'Pegá una transcripción más larga.'; return; }
  const title = (titleInput?.value || '').trim() || 'Referente manual';
  if (status) status.textContent = 'Guardando…';
  try {
    const truncated = text.substring(0, 1500);
    let embedding = null;
    if (worker && p.aiMode === 'embeddings') {
      const result = await workerSend('EMBED_TEXTS', { texts: [{ id: 'ref', text: truncated }] });
      embedding = result.embeddings?.ref ? new Float32Array(result.embeddings.ref) : null;
    }
    await put('references', {
      id: crypto.randomUUID(), url: '', videoId: null,
      title, channel: '', language: 'manual',
      transcript: text, transcriptTruncated: truncated,
      embedding, createdAt: Date.now()
    });
    if (status) status.textContent = '✓ ' + title;
    if (titleInput) titleInput.value = '';
    if (textArea) textArea.value = '';
    renderReferenceList(); populateCompareTargets(); populateGapRefTargets(); populateRefGapTargets();
    const sec = document.getElementById('ref-gap-section');
    if (sec) { const refs = await all('references'); sec.hidden = refs.length === 0; }
  } catch (err) {
    if (status) status.textContent = 'Error: ' + err.message;
  }
}

async function deleteReference(id) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('references', 'readwrite');
    tx.objectStore('references').delete(id);
    tx.oncomplete = () => { renderReferenceList(); populateCompareTargets(); populateGapRefTargets(); populateRefGapTargets(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

async function renderReferenceList() {
  const container = $('#ref-list');
  if (!container) return;
  const refs = await all('references');
  refs.sort((a, b) => b.createdAt - a.createdAt);
  if (!refs.length) { container.innerHTML = '<small>Sin referentes.</small>'; return; }
  container.innerHTML = refs.map(r =>
    '<div class="ref-item"><div class="ref-item-info"><div class="ref-item-title">' + esc(r.title || 'Sin título') + '</div><div class="ref-item-channel">' + esc(r.channel || '') + '</div></div>' +
    '<button class="ref-item-delete" data-del-ref="' + r.id + '" title="Eliminar">' + TRASH_SVG + '</button></div>'
  ).join('');
  container.querySelectorAll('[data-del-ref]').forEach(btn => { btn.onclick = () => deleteReference(btn.dataset.delRef); });
  const sec = $('#ref-gap-section');
  if (sec) sec.hidden = refs.length === 0;
}

/* ====================================================================
   BIND — Pestaña Análisis IA
   ==================================================================== */
function bindAnalysis() {
  const btn = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  const on = (id, evt, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn); };
  btn('run-extractive', runExtractive);
  btn('run-redundancy', runRedundancy);
  btn('run-density', runDensity);
  btn('run-compare', runCompare);
  btn('run-gaps', runGaps);
  btn('run-refgaps', runRefGaps);
  on('compare-source', 'change', () => { populateCompareTargets(); });
  on('gap-use-ref', 'change', (e) => {
    const sel = document.getElementById('gap-ref-target');
    if (sel) sel.disabled = !e.target.checked;
    if (e.target.checked) populateGapRefTargets();
  });
  btn('add-reference', addReference);
  on('youtube-url', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addReference(); } });
  btn('add-paste-reference', addManualReference);
  btn('open-refs', () => { const dialog = $('#refdialog'); if (typeof dialog.showModal === 'function') dialog.showModal(); else { dialog.setAttribute('open', ''); dialog.style.display = 'block' } renderReferenceList(); });
  btn('close-refs', () => { const dialog = $('#refdialog'); dialog.close?.() || (dialog.removeAttribute('open'), dialog.style.display = 'none'); });
  const tabBtn = document.querySelector('[data-tab="analysis"]');
  if (tabBtn) tabBtn.addEventListener('click', () => { populateCompareTargets(); populateGapRefTargets(); populateRefGapTargets(); updateAnalysisTabState(); });
}

boot().catch(error => { console.error(error); const message = 'ScriptLab no pudo iniciarse: ' + error.message; document.body.insertAdjacentHTML('afterbegin', '<div style="padding:12px;background:#ff6879;color:#20101a;position:fixed;z-index:9999;left:0;right:0;top:0">' + message + '</div>'); });