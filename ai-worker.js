let extractor=null, mode='basic';
async function loadExtractor(){
 if(extractor)return extractor;
 const {pipeline,env}=await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2');
 env.useBrowserCache=true;env.allowRemoteModels=true;
 extractor=await pipeline('feature-extraction','Xenova/multilingual-e5-small',{device:'wasm',progress_callback:p=>postMessage({type:'PROGRESS',message:p.status==='progress'?`Descargando modelo: ${Math.round(p.progress||0)}%`:'Preparando modelo local…'})});
 return extractor;
}
self.onmessage=async({data})=>{try{if(data.type==='INIT'){mode=data.mode||'basic';if(mode==='embeddings'){postMessage({type:'PROGRESS',message:'Cargando motor IA local…'});await loadExtractor()}postMessage({type:'READY',mode});return}if(data.type==='EMBED'&&mode==='embeddings'){const out=await(await loadExtractor())(data.texts.map(x=>x.text||''),{pooling:'mean',normalize:true}),v=out.tolist(),map=Object.fromEntries(data.texts.map((x,i)=>[x.id,v[i]])),dot=(a,b)=>a&&b?a.reduce((s,x,i)=>s+x*b[i],0):0,blocks=data.texts.filter(x=>x.role==='block'),adj=[];for(let i=1;i<blocks.length;i++)adj.push(dot(map[blocks[i-1].id],map[blocks[i].id]));postMessage({type:'EMBED_RESULT',requestId:data.requestId,cacheId:data.cacheId,alignment:dot(map.hook,map.promise),titleAlignment:dot(map.hook,map.title),redundancy:adj.length?Math.max(...adj):0,confidence:.72})}}catch(error){postMessage({type:'ERROR',requestId:data.requestId,message:error.message})}};
