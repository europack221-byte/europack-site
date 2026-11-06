const {createClient}=require('@supabase/supabase-js');
const URL=process.env.SUPABASE_URL;
const SECRET=process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUB=process.env.SUPABASE_PUBLISHABLE_KEY;
const json=(code,obj)=>({statusCode:code,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'same-origin'},body:JSON.stringify(obj)});
const fail=(code,msg)=>json(code,{error:msg});
const err=(x)=>{if(x.error)throw Error(x.error.message);return x.data};
const number=(v,min,max)=>{const n=Number(v);if(!Number.isFinite(n)||n<min||n>max)throw Error('قيمة غير صحيحة');return n};
const clean=(s,n=200)=>String(s??'').trim().slice(0,n);
const admin=()=>createClient(URL,SECRET,{auth:{persistSession:false,autoRefreshToken:false}});
async function requireAdmin(event,db){const token=(event.headers.authorization||event.headers.Authorization||'').replace(/^Bearer\s+/i,'');if(!token)throw Error('يرجى تسجيل الدخول');const {data,error}=await db.auth.getUser(token);if(error||!data.user)throw Error('جلسة الدخول غير صالحة');const rows=err(await db.from('admin_users').select('user_id').eq('user_id',data.user.id).limit(1));if(!rows.length)throw Error('ليس لديك صلاحية الإدارة');return data.user;}
const priceCode=(color,layers,lam)=>color==='colored'?`colored_${layers}_${lam?'lamination':'no_lamination'}`:`${color}_${layers}`;
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const getSetting=async(db)=>err(await db.from('company_settings').select('*').eq('id',1).single());
const validProof=(file)=>{if(!file)return null;const mime=clean(file.mime,80),types=['image/jpeg','image/png','image/webp','application/pdf'];if(!types.includes(mime))throw Error('صيغة الإيصال غير مدعومة');if(typeof file.base64!=='string'||file.base64.length>8_000_000)throw Error('الإيصال كبير جداً');const bytes=Buffer.from(file.base64,'base64');if(!bytes.length||bytes.length>5_000_000)throw Error('الإيصال يجب ألا يتجاوز 5MB');const ok=mime==='application/pdf'?bytes.subarray(0,5).toString()==='%PDF-':mime==='image/png'?bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a':mime==='image/jpeg'?bytes.subarray(0,3).toString('hex')==='ffd8ff':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';if(!ok)throw Error('محتوى الملف لا يطابق نوعه');return {bytes,mime,ext:{'application/pdf':'pdf','image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime]};};
exports.handler=async(event)=>{
 if(event.httpMethod==='OPTIONS')return {statusCode:204,body:''};
 if(!URL||!SECRET||!PUB)return fail(503,'إعدادات الخادم ناقصة. أضف متغيرات Supabase في Netlify.');
 const db=admin();let body={};try{if(event.body){if(event.body.length>8_000_000)return fail(413,'الطلب كبير');body=JSON.parse(event.body)}}catch{return fail(400,'بيانات غير صحيحة')}
 const action=clean(event.queryStringParameters?.action||body.action,40);
 try{
 if(action==='public'&&event.httpMethod==='GET'){
 const settings=await getSetting(db);const prices=err(await db.from('products_pricing').select('code,label,price_usd,active').eq('active',true));
 return json(200,{prices,settings:{company_name:settings.company_name,phone:settings.phone,whatsapp:settings.whatsapp,address:settings.address,fx_rate:settings.fx_rate,tax_percent:settings.tax_percent,payment_terms:settings.payment_terms,shamcash_qr_path:settings.shamcash_qr_path}});
 }
 if(action==='order'&&event.httpMethod==='POST'){
 // A server-side anti-bot layer (Netlify rate limiting/CAPTCHA) is still required before public launch.
 const name=clean(body.name,160),phone=clean(body.phone,60),address=clean(body.address,350);
 if(name.length<2||phone.length<7||address.length<3)throw Error('الاسم والهاتف والعنوان مطلوبين');
 const L=number(body.length,1,500),W=number(body.width,1,500),H=number(body.height,1,500),qty=number(body.quantity,1,1000000);
 if(!Number.isInteger(qty))throw Error('الكمية يجب أن تكون عدداً صحيحاً');
 const layers=Number(body.layers),color=clean(body.color,20),lam=Boolean(body.lamination),flexo=number(body.flexo,0,4);
 if(![3,5].includes(layers)||!['brown','white','colored'].includes(color)||!Number.isInteger(flexo))throw Error('خيار الكرتون غير مدعوم');
 if(qty<(color==='colored'?1500:500))throw Error('الكمية أقل من الحد الأدنى');
 const currency=body.currency==='SYP'?'SYP':'USD',method=body.method==='shamcash'?'shamcash':'cash';
 const price=err(await db.from('products_pricing').select('price_usd').eq('code',priceCode(color,layers,lam)).eq('active',true).single());
 const settings=await getSetting(db),fx=number(settings.fx_rate,1,10000000),rate=number(price.price_usd,0,10000);
 const sheetL=2*(L+W)+5,sheetW=W+H,area=sheetL*sheetW/10000;
 const unitUSD=area*rate,baseUSD=unitUSD*qty,discountUSD=qty>=5000?baseUSD*.05:0;
 const subtotalUSD=baseUSD-discountUSD,taxUSD=subtotalUSD*Number(settings.tax_percent||0)/100;
 const factor=currency==='SYP'?fx:1,total=round((subtotalUSD+taxUSD)*factor),deposit=round(total*.5);
 const proof=method==='shamcash'?validProof(body.proof):null;
 const customer=err(await db.from('customers').insert({full_name:name,phone,address}).select('id').single());
 const delivery=new Date(Date.now()+(color==='colored'?12:7)*86400000).toISOString().slice(0,10);
 const order=err(await db.from('orders').insert({customer_id:customer.id,length_cm:L,width_cm:W,height_cm:H,quantity:qty,layers,board_color:color,lamination:lam,flexo_colors:flexo,currency,fx_rate:fx,sheet_length_cm:sheetL,sheet_width_cm:sheetW,unit_price:round(unitUSD*factor),discount_amount:round(discountUSD*factor),tax_amount:round(taxUSD*factor),total_amount:total,deposit_required:deposit,status:'new',payment_method:method,delivery_date:delivery}).select('id').single());
 const invoice=err(await db.from('invoices').insert({order_id:order.id,currency,subtotal:round(baseUSD*factor),discount:round(discountUSD*factor),tax:round(taxUSD*factor),total,company_snapshot:{name:settings.company_name,phone:settings.phone,address:settings.address},customer_snapshot:{name,phone,address},lines:[{description:`كرتون ${color} ${layers} طبقات ${lam?'مع سلفان':''} - فلكسو ${flexo} لون`,quantity:qty,unit_price:round(unitUSD*factor),length_cm:L,width_cm:W,height_cm:H}]}).select('invoice_no').single());
 let proofWarning=null;
 if(proof){try{
 const payment=err(await db.from('payments').insert({order_id:order.id,amount:deposit,currency,method:'shamcash',status:'pending',note:'إيصال أرسله الزبون - بانتظار التحقق'}).select('id').single());
 const path=`${order.id}/${payment.id}.${proof.ext}`;
 err(await db.storage.from('europack-payment-proofs').upload(path,proof.bytes,{contentType:proof.mime,upsert:false}));
 err(await db.from('payment_proofs').insert({payment_id:payment.id,storage_path:path,original_filename:'receipt.'+proof.ext,mime_type:proof.mime}));
 await db.from('notifications').insert({kind:'new_payment_proof',order_id:order.id,payment_id:payment.id,message:`إيصال جديد ${invoice.invoice_no} - بانتظار التأكيد`});
 }catch(e){proofWarning='تم إنشاء الطلب لكن تعذر حفظ الإيصال. تواصل مع الشركة وأعد إرسال الإيصال.';}}
 await db.from('notifications').insert({kind:'new_order',order_id:order.id,message:`طلب جديد EP-${invoice.invoice_no} - ${name}`});
 return json(200,{invoice:`EP-${invoice.invoice_no}`,order_id:order.id,total,deposit,currency,delivery,proof_warning:proofWarning});
 }
 if(action==='login'&&event.httpMethod==='POST'){
 const client=createClient(URL,PUB,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data,error}=await client.auth.signInWithPassword({email:clean(body.email,180),password:String(body.password||'')});if(error)throw Error('البريد أو كلمة المرور غير صحيحة');
 const rows=err(await db.from('admin_users').select('user_id').eq('user_id',data.user.id));if(!rows.length)throw Error('الحساب ليس مديراً');return json(200,{token:data.session.access_token,expires_at:data.session.expires_at});
 }
 if(action==='admin'&&event.httpMethod==='GET'){
 await requireAdmin(event,db);
 const [orders,payments,customers,invoices,notes,prices,settings]=await Promise.all([
 db.from('orders').select('*').order('created_at',{ascending:false}).limit(200),db.from('payments').select('*').order('created_at',{ascending:false}).limit(500),db.from('customers').select('*').limit(300),db.from('invoices').select('*').order('invoice_no',{ascending:false}).limit(200),db.from('notifications').select('*').order('created_at',{ascending:false}).limit(100),db.from('products_pricing').select('*'),getSetting(db)]);
 return json(200,{orders:err(orders),payments:err(payments),customers:err(customers),invoices:err(invoices),notifications:err(notes),prices:err(prices),settings});
 }
 if(action==='payment'&&event.httpMethod==='POST'){
 await requireAdmin(event,db);const orderId=clean(body.order_id,50);const order=err(await db.from('orders').select('id,currency,total_amount').eq('id',orderId).single());
 if(body.operation==='add'){const amount=number(body.amount,.01,100000000000);const p=err(await db.from('payments').insert({order_id:orderId,amount,currency:order.currency,method:['cash','shamcash','other'].includes(body.method)?body.method:'cash',status:'confirmed',paid_at:new Date().toISOString(),note:clean(body.note,250)}).select('id').single());return json(200,{id:p.id});}
 const id=clean(body.payment_id,60);const payment=err(await db.from('payments').select('*').eq('id',id).eq('order_id',orderId).single());
 if(body.operation==='confirm'||body.operation==='reject'){err(await db.from('payments').update({status:body.operation==='confirm'?'confirmed':'rejected',paid_at:body.operation==='confirm'?new Date().toISOString():null}).eq('id',payment.id));return json(200,{ok:true});}
 if(body.operation==='edit'){err(await db.from('payments').update({amount:number(body.amount,.01,100000000000),note:clean(body.note,250)}).eq('id',payment.id));return json(200,{ok:true});}
 if(body.operation==='delete'){const proofs=err(await db.from('payment_proofs').select('storage_path').eq('payment_id',id));if(proofs.length)err(await db.storage.from('europack-payment-proofs').remove(proofs.map(x=>x.storage_path)));err(await db.from('payments').delete().eq('id',id));return json(200,{ok:true});}
 }
 if(action==='pricing'&&event.httpMethod==='POST'){await requireAdmin(event,db);const code=clean(body.code,80);const p=err(await db.from('products_pricing').update({price_usd:number(body.price,0,10000),updated_at:new Date().toISOString()}).eq('code',code).select('code').single());return json(200,{ok:true,code:p.code});}
 if(action==='settings'&&event.httpMethod==='POST'){await requireAdmin(event,db);const fields={};for(const k of ['phone','whatsapp','address','tax_number','commercial_registration','payment_terms','invoice_notes'])if(k in body)fields[k]=clean(body[k],500);if('fx_rate'in body)fields.fx_rate=number(body.fx_rate,1,10000000);if('tax_percent'in body)fields.tax_percent=number(body.tax_percent,0,100);err(await db.from('company_settings').update(fields).eq('id',1));return json(200,{ok:true});}
 if(action==='proof'&&event.httpMethod==='GET'){await requireAdmin(event,db);const paymentId=clean(event.queryStringParameters.payment_id,60);const rows=err(await db.from('payment_proofs').select('storage_path').eq('payment_id',paymentId).limit(1));if(!rows.length)throw Error('لا يوجد إيصال');const data=err(await db.storage.from('europack-payment-proofs').createSignedUrl(rows[0].storage_path,60));return json(200,{url:data.signedUrl});}
 return fail(404,'الطلب غير موجود');
 }catch(e){console.error('europack api:',e.message);return fail(/صلاحية|جلسة|تسجيل الدخول/.test(e.message)?403:400,e.message||'تعذر تنفيذ العملية')}
};
