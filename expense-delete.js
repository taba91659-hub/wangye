(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const status = (text, error=false) => { $('status').textContent=text; $('status').dataset.error=String(error); };
  const params=new URLSearchParams(location.hash.slice(1));
  const draftId=params.get('draft');
  if(params.getAll('draft').length!==1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draftId||'')) {
    status('请从 ChatGPT 提供的账单确认链接打开本页。',true);return;
  }
  if(!window.supabase?.createClient){status('登录组件未加载，请刷新重试。',true);return;}
  const db=window.supabase.createClient('https://joyqlelzapraawudhuxn.supabase.co','sb_publishable_7_nDQatwVBChB4yotQ8YwA_ugViwwAL',{
    auth:{persistSession:false,detectSessionInUrl:false,autoRefreshToken:true}
  });
  let busy=false, canSave=false;
  const lock=value=>{busy=value;for(const id of ['login-button','refresh','signout'])$(id).disabled=value;$('confirm').disabled=value||!canSave;};
  async function load(){
    canSave=false;$('draft').hidden=true;
    const {data:user,error:userError}=await db.auth.getUser();
    if(userError||!user?.user){$('login').hidden=false;status('请登录平时使用的记账账号。');return;}
    $('login').hidden=true;$('signout').hidden=false;
    const {data,error}=await db.rpc('ledger_mcp_get_deletion',{p_draft_id:draftId});
    if(error||!data)throw Error('无法读取这份草稿。请检查账号是否正确、功能是否启用。');
    $('account').textContent=user.user.email||'当前账号';
    for(const [id,key] of [['name','name'],['amount','amount_yuan'],['category','category'],['date','date']])$(id).textContent=data[key];
    $('draft').hidden=false;
    canSave=data.status==='awaiting_user_confirmation';
    status(data.status==='changed'?'账单内容已变化，请回到 ChatGPT 重新选择。':data.status==='missing'?'账单已不存在，无需删除。':data.status==='deleted'?'这笔账单已删除，不会重复删除。':data.status==='expired'?'草稿已过期，请回到 ChatGPT 创建新草稿。':'请核对上面的内容，再决定是否删除。');
  }
  $('login').addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;lock(true);
    try{const {error}=await db.auth.signInWithPassword({email:$('email').value.trim(),password:$('password').value});
      if(error)throw Error('登录失败，请检查邮箱和密码。');await load();
    }catch(e){status(e.message,true);}finally{$('password').value='';lock(false);}
  });
  $('confirm').addEventListener('click',async()=>{
    if(busy||!canSave)return;lock(true);
    try{
      const {data,error}=await db.rpc('ledger_mcp_confirm_deletion',{p_draft_id:draftId});
      if(error||data?.status!=='deleted')throw Error('未确认删除结果。请点“检查删除状态”；重试同一草稿不会删除其他账单。');
      canSave=false;status('已删除这笔账单。可以回到 ChatGPT，让它检查删除状态。');
    }catch(e){status(e.message,true);}finally{lock(false);}
  });
  $('refresh').addEventListener('click',async()=>{if(busy)return;lock(true);try{await load();}catch(e){status(e.message,true);}finally{lock(false);}});
  $('signout').addEventListener('click',async()=>{if(busy)return;lock(true);try{
    await db.auth.signOut({scope:'local'});canSave=false;$('draft').hidden=true;$('signout').hidden=true;$('login').hidden=false;status('已退出此确认页。');
  }finally{lock(false);}});
  lock(true);load().catch(e=>status(e.message,true)).finally(()=>lock(false));
})();
