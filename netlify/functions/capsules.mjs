import { getStore } from '@netlify/blobs';

const blobStore = name => getStore(name, { consistency: 'strong' });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });

const cleanSlug = value =>
  (value || crypto.randomUUID().slice(0, 8))
    .toLowerCase().trim().replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || crypto.randomUUID().slice(0, 8);

const adminPassword = () => Netlify.env.get('ADMIN_PASSWORD') || '';
const isAdmin = req => {
  const supplied = req.headers.get('x-admin-password') || '';
  return !!adminPassword() && supplied === adminPassword();
};

export default async req => {
  try {
    const capsules = blobStore('capsules');
    const media = blobStore('capsule-media');
    const orders = blobStore('capsule-orders');
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/(?:api\/capsules|\.netlify\/functions\/capsules)\/?/, '');
    const parts = path.split('/').filter(Boolean);

    if (req.method === 'POST' && parts[0] === 'login') {
      return isAdmin(req) ? json({ ok: true }) : json({ error: 'Contraseña incorrecta' }, 401);
    }

    if (parts[0] === 'audio-upload' && req.method === 'POST') {
      if (!isAdmin(req)) return json({error:'No autorizado'},401);
      const input=await req.json(), match=String(input.dataUrl||'').match(/^data:(audio\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if(!match)return json({error:'Audio no válido'},400);
      const bytes=Uint8Array.from(atob(match[2]),x=>x.charCodeAt(0));
      if(bytes.byteLength>8*1024*1024)return json({error:'El audio supera 8 MB'},413);
      const key='voice-'+Date.now()+'-'+crypto.randomUUID();
      await media.set(key,bytes.buffer,{metadata:{contentType:match[1]}});
      return json({url:'/api/capsules/media/'+encodeURIComponent(key)});
    }

    if (parts[0] === 'order-upload' && req.method === 'POST') {
      const input=await req.json();
      const match=String(input.dataUrl||'').match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
      if(!match)return json({error:'Imagen no válida'},400);
      const bytes=Uint8Array.from(atob(match[2]),x=>x.charCodeAt(0));
      if(bytes.byteLength>4*1024*1024)return json({error:'La imagen es demasiado grande'},413);
      const ext=match[1]==='image/png'?'png':match[1]==='image/webp'?'webp':'jpg';
      const key='customer-'+Date.now()+'-'+crypto.randomUUID()+'.'+ext;
      await media.set(key,bytes.buffer,{metadata:{contentType:match[1]}});
      return json({url:'/api/capsules/media/'+encodeURIComponent(key)});
    }

    if (parts[0] === 'orders' && req.method === 'POST') {
      const input = await req.json();
      const allowedPlans = ['Esencial','Premium','Especial'];
      const allowedThemes = ['romantic','dark','gold','mystic','natural','sunset','sky','passion','minimal'];
      const order = {
        id: crypto.randomUUID(),
        client: String(input.client || '').trim().slice(0,120),
        whatsapp: String(input.whatsapp || '').replace(/[^0-9+]/g,'').slice(0,20),
        recipient: String(input.recipient || '').trim().slice(0,120),
        occasion: String(input.occasion || '').trim().slice(0,80),
        package: allowedPlans.includes(input.package) ? input.package : 'Premium',
        theme: allowedThemes.includes(input.theme) ? input.theme : 'romantic',
        message: String(input.message || '').trim().slice(0,3000),
        music: String(input.music || '').trim().slice(0,500),
        experience: ['classic','cinematic','story','birthday','proposal'].includes(input.experience) ? input.experience : 'cinematic',
        voice: String(input.voice || '').trim().slice(0,1000),
        video: String(input.video || '').trim().slice(0,1000),
        unlockAt: String(input.unlockAt || '').trim().slice(0,40),
        secret: String(input.secret || '').trim().slice(0,120),
        notes: String(input.notes || '').trim().slice(0,1500),
        photos: Array.isArray(input.photos) ? input.photos.slice(0, input.package==='Esencial'?3:8) : [],
        status: 'Nuevo',
        createdAt: new Date().toISOString()
      };
      if (!order.client || !order.whatsapp || !order.recipient || !order.message) return json({ error: 'Completa nombre, WhatsApp, destinatario y mensaje' }, 400);
      await orders.setJSON('order-'+order.id, order);
      return json({ ok:true, id:order.id });
    }

    if (parts[0] === 'stripe-webhook' && req.method === 'POST') {
      const secret=Netlify.env.get('STRIPE_WEBHOOK_SECRET')||'';
      if(!secret.startsWith('whsec_'))return json({error:'Webhook de Stripe no configurado'},500);
      const payload=await req.text();
      const sig=req.headers.get('stripe-signature')||'';
      const fields=Object.fromEntries(sig.split(',').map(x=>x.split('=',2)));
      const timestamp=fields.t, received=fields.v1;
      if(!timestamp||!received)return json({error:'Firma faltante'},400);
      const enc=new TextEncoder();
      const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
      const mac=await crypto.subtle.sign('HMAC',key,enc.encode(timestamp+'.'+payload));
      const expected=[...new Uint8Array(mac)].map(b=>b.toString(16).padStart(2,'0')).join('');
      const a=enc.encode(expected),b=enc.encode(received);
      let diff=a.length^b.length; for(let i=0;i<Math.min(a.length,b.length);i++)diff|=a[i]^b[i];
      if(diff!==0||Math.abs(Date.now()/1000-Number(timestamp))>300)return json({error:'Firma inválida'},400);
      const event=JSON.parse(payload);
      if(event.type==='checkout.session.completed'&&event.data?.object?.payment_status==='paid'){
        const session=event.data.object, id=session.metadata?.order_id||session.client_reference_id;
        if(id){const keyName='order-'+id,order=await orders.get(keyName,{type:'json'});if(order){order.status='En producción';order.paymentStatus='Pagado';order.paidAt=new Date().toISOString();order.productionStartedAt=new Date().toISOString();order.stripeSessionId=session.id;await orders.setJSON(keyName,order)}}
      }
      return json({received:true});
    }

    if (parts[0] === 'checkout' && parts[1] && req.method === 'POST') {
      const order=await orders.get('order-'+parts[1],{type:'json'});
      if(!order)return json({error:'Pedido no encontrado'},404);
      const prices={Esencial:3900,Premium:5900,Especial:6900};
      const secret=Netlify.env.get('STRIPE_SECRET_KEY')||'';
      const stripeMode=secret.startsWith('sk_live_')?'live':secret.startsWith('sk_test_')?'test':secret.startsWith('rk_live_')?'live':secret.startsWith('rk_test_')?'test':'';
      if(!stripeMode)return json({error:'Stripe no está configurado correctamente'},500);
      const origin=new URL(req.url).origin;
      const body=new URLSearchParams();
      body.set('mode','payment');
      body.set('success_url',origin+'/?payment=success&order='+encodeURIComponent(order.id));
      body.set('cancel_url',origin+'/?payment=cancelled&order='+encodeURIComponent(order.id));
      body.set('client_reference_id',order.id);
      body.set('metadata[order_id]',order.id);
      body.set('line_items[0][quantity]','1');
      body.set('line_items[0][price_data][currency]','mxn');
      body.set('line_items[0][price_data][unit_amount]',String(prices[order.package]||5900));
      body.set('line_items[0][price_data][product_data][name]','Cápsula Digital '+order.package);
      const sr=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/x-www-form-urlencoded'},body});
      const session=await sr.json();
      if(!sr.ok)return json({error:session?.error?.message||'No se pudo iniciar el pago'},502);
      order.stripeSessionId=session.id; order.paymentStatus='Pendiente'; order.stripeMode=stripeMode; order.updatedAt=new Date().toISOString();
      await orders.setJSON('order-'+order.id,order);
      return json({url:session.url,mode:stripeMode});
    }

    if (parts[0] === 'orders' && parts[1] && req.method === 'PATCH') {
      if (!isAdmin(req)) return json({ error:'No autorizado' },401);
      const key='order-'+parts[1], current=await orders.get(key,{type:'json'});
      if(!current)return json({error:'Pedido no encontrado'},404);
      const input=await req.json(), allowed=['Nuevo','Contactado','Pagado','En producción','Entregado'];
      if(!allowed.includes(input.status))return json({error:'Estado no válido'},400);
      current.status=input.status; current.updatedAt=new Date().toISOString();
      await orders.setJSON(key,current); return json({ok:true,status:current.status});
    }

    if (parts[0] === 'replies' && req.method === 'GET') {
      if (!isAdmin(req)) return json({ error:'No autorizado' },401);
      const replies=blobStore('capsule-replies'), {blobs}=await replies.list({prefix:'reply-'}), rows=[];
      for(const blob of blobs){const r=await replies.get(blob.key,{type:'json'});if(r){const cap=await capsules.get('capsule-'+r.slug,{type:'json'});rows.push({...r,capsuleName:cap?.name||r.slug,opens:Number(cap?.opens)||0,lastOpenedAt:cap?.lastOpenedAt||''})}}
      return json(rows.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')));
    }

    if (parts[0] === 'orders' && req.method === 'GET') {
      if (!isAdmin(req)) return json({ error:'No autorizado' },401);
      const { blobs } = await orders.list({ prefix:'order-' });
      const rows=[]; for (const blob of blobs){ const d=await orders.get(blob.key,{type:'json'}); if(d) rows.push(d); }
      return json(rows.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')));
    }

    if (req.method === 'POST' && parts[0] === 'upload') {
      if (!isAdmin(req)) return json({ error: 'No autorizado' }, 401);
      const input = await req.json();
      const match = String(input.dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
      if (!match) return json({ error: 'Imagen no válida' }, 400);
      const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
      if (bytes.byteLength > 4 * 1024 * 1024) return json({ error: 'La imagen es demasiado grande' }, 413);
      const ext = match[1] === 'image/png' ? 'png' : match[1] === 'image/webp' ? 'webp' : 'jpg';
      const key = `photo-${Date.now()}-${crypto.randomUUID()}.${ext}`;
      await media.set(key, bytes.buffer, { metadata: { contentType: match[1] } });
      return json({ url: `/api/capsules/media/${encodeURIComponent(key)}` });
    }

    if (req.method === 'GET' && parts[0] === 'media' && parts[1]) {
      const key = decodeURIComponent(parts.slice(1).join('/'));
      const entry = await media.getWithMetadata(key, { type: 'arrayBuffer' });
      if (!entry) return json({ error: 'Imagen no encontrada' }, 404);
      return new Response(entry.data, {
        headers: {
          'content-type': entry.metadata?.contentType || 'image/jpeg',
          'cache-control': 'public, max-age=31536000, immutable'
        }
      });
    }

    if (req.method === 'POST' && parts.length === 0) {
      if (!isAdmin(req)) return json({ error: 'No autorizado' }, 401);
      const data = await req.json();
      const slug = cleanSlug(data.slug);
      data.slug = slug;
      data.photos = Array.isArray(data.photos) ? data.photos.slice(0, 8) : [];
      data.updatedAt = new Date().toISOString();
      await capsules.setJSON(`capsule-${slug}`, data);
      return json({ ok: true, slug });
    }

    if (req.method === 'DELETE' && parts[0]) {
      if (!isAdmin(req)) return json({ error: 'No autorizado' }, 401);
      const key = `capsule-${parts[0]}`;
      const data = await capsules.get(key, { type: 'json' });
      if (!data) return json({ error: 'No encontrada' }, 404);
      await capsules.delete(key);
      return json({ ok: true });
    }

    if (req.method === 'POST' && parts[0] && parts[1] === 'reaction') {
      const key='capsule-'+parts[0], data=await capsules.get(key,{type:'json'});
      if(!data)return json({error:'No encontrada'},404);
      const input=await req.json(), allowed=['😍 Me encantó','🥹 Me hiciste llorar','❤️ Te amo','🫶 Gracias'];
      if(!allowed.includes(input.reaction))return json({error:'Reacción no válida'},400);
      const reactions=blobStore('capsule-reactions'),id=crypto.randomUUID();
      await reactions.setJSON('reaction-'+id,{id,slug:parts[0],reaction:input.reaction,createdAt:new Date().toISOString()});
      data.reactions=(Number(data.reactions)||0)+1;await capsules.setJSON(key,data);
      return json({ok:true});
    }

    if (req.method === 'POST' && parts[0] && parts[1] === 'reply') {
      const key = `capsule-${parts[0]}`, data = await capsules.get(key,{type:'json'});
      if(!data)return json({error:'No encontrada'},404);
      const input=await req.json(), message=String(input.message||'').trim().slice(0,2000);
      if(!message)return json({error:'Escribe una respuesta'},400);
      const replies=blobStore('capsule-replies'), id=crypto.randomUUID();
      await replies.setJSON('reply-'+id,{id,slug:parts[0],message,createdAt:new Date().toISOString()});
      return json({ok:true});
    }

    if (req.method === 'GET' && parts[0]) {
      const key=`capsule-${parts[0]}`, data = await capsules.get(key, { type: 'json' });
      if(!data)return json({ error: 'No encontrada' }, 404);
      data.opens=(Number(data.opens)||0)+1; const openedAt=new Date().toISOString(); if(!data.firstOpenedAt)data.firstOpenedAt=openedAt; data.lastOpenedAt=openedAt;
      await capsules.setJSON(key,data);
      return json(data);
    }

    if (req.method === 'GET') {
      if (!isAdmin(req)) return json({ error: 'No autorizado' }, 401);
      const { blobs } = await capsules.list({ prefix: 'capsule-' });
      const rows = [];
      for (const blob of blobs) {
        const data = await capsules.get(blob.key, { type: 'json' });
        if (data) rows.push(data);
      }
      return json(rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));
    }

    return json({ error: 'Método no permitido' }, 405);
  } catch (error) {
    return json({ error: error.message }, 500);
  }
};

export const config = {
  path: ['/api/capsules', '/api/capsules/*']
};
