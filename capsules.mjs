import { getStore } from '@netlify/blobs';
const store = getStore('capsules',{consistency:'strong'});
const json=(statusCode,body)=>({statusCode,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
export default async (req,ctx)=>{
 try{
  const u=new URL(req.url); const id=u.pathname.split('/').filter(Boolean).pop();
  if(req.method==='POST'){
   const data=await req.json(); const slug=(data.slug||crypto.randomUUID().slice(0,8)).toLowerCase().replace(/[^a-z0-9-]/g,'');
   data.slug=slug; data.updatedAt=new Date().toISOString(); await store.setJSON(`capsule-${slug}`,data); return json(200,{ok:true,slug});
  }
  if(req.method==='GET' && id && id!=='capsules'){
   const data=await store.get(`capsule-${id}`,{type:'json'}); return data?json(200,data):json(404,{error:'No encontrada'});
  }
  if(req.method==='GET'){
   const {blobs}=await store.list({prefix:'capsule-'}); const rows=[]; for(const b of blobs){const d=await store.get(b.key,{type:'json'}); if(d) rows.push(d)} return json(200,rows.sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||'')));
  }
  return json(405,{error:'Método no permitido'});
 }catch(e){return json(500,{error:e.message})}
}
