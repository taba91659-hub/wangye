/* Public browser configuration: publishable key only, never a database/admin secret. */
(() => {
  'use strict';
  const PROJECT = 'https://joyqlelzapraawudhuxn.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_7_nDQatwVBChB4yotQ8YwA_ugViwwAL';
  const $ = id => document.getElementById(id);
  const status = (message, error = false) => { $('status').textContent = message; $('status').dataset.error = String(error); };
  const LEDGER_CLIENT_ID = '9613b45d-a946-494f-a3d4-a91b784b7eca';
  let busy = false, clientId = null, existingRedirect = null;
  const params = new URLSearchParams(location.search);
  const authorizationId = params.get('authorization_id');
  if (params.getAll('authorization_id').length !== 1 || !/^[a-zA-Z0-9_-]{8,200}$/.test(authorizationId || '')) {
    status('这是专用授权页。请从 ChatGPT 的连接按钮重新开始，不能直接在这里发起授权。', true); return;
  }
  if (!window.supabase?.createClient) { status('登录组件未加载，请检查网络后刷新。', true); return; }
  // No persistent session, no use of the original app's localStorage session.
  const db = window.supabase.createClient(PROJECT, PUBLISHABLE_KEY, {
    auth: { persistSession: false, detectSessionInUrl: false, autoRefreshToken: false },
  });
  function callback(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.username || url.password || url.port ||
        !(url.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[a-zA-Z0-9_-]+$/.test(url.pathname)))
      throw Error('返回地址不在已支持的 ChatGPT 授权地址中，请核对 OAuth 客户端配置。');
    return url.href;
  }
  async function allowed(id) {
    const { data, error } = await db.rpc('ledger_mcp_consent_allowed', { p_client_id: id });
    return !error && data === true;
  }
  function lock(value) {
    busy = value;
    for (const id of ['approve','deny','login-button','signout']) $(id).disabled = value;
  }
  async function loadConsent() {
    clientId = null; existingRedirect = null;
    $('consent').hidden = true;
    const { data: userData, error: userError } = await db.auth.getUser();
    if (userError || !userData.user) { $('login').hidden = false; status('请先登录记账账号，随后查看授权内容。'); return; }
    $('login').hidden = true; $('signout').hidden = false;
    const { data, error } = await db.auth.oauth.getAuthorizationDetails(authorizationId);
    if (error || !data) throw Error('授权请求无效或已过期，请从 ChatGPT 重新连接。');
    if (!('authorization_id' in data)) {
      if (!data.redirect_url) throw Error('授权响应缺少返回地址，请重新连接。');
      const destination = callback(data.redirect_url);
      if (!(await allowed(LEDGER_CLIENT_ID))) throw Error('这个账号或应用尚未绑定到只读连接。');
      clientId = LEDGER_CLIENT_ID;
      existingRedirect = destination;
      $('account').textContent = userData.user.email || '当前登录账号';
      $('client').textContent = '我的记账本（只读）';
      $('redirect').textContent = new URL(destination).origin;
      $('scope').textContent = '沿用你之前授予此应用的权限';
      $('approve').textContent = '继续返回 ChatGPT';
      $('deny').textContent = '撤销此应用授权';
      $('consent').hidden = false;
      status('你之前已经授权。可以继续连接，或撤销此应用的已有授权。'); return;
    }
    callback(data.redirect_uri);
    if (!data.client?.id || !(await allowed(data.client.id))) throw Error('这个账号或应用尚未绑定到只读连接，请先完成部署配置。');
    clientId = data.client.id;
    $('approve').textContent = '同意连接';
    $('deny').textContent = '拒绝';
    $('account').textContent = userData.user.email || '当前登录账号';
    $('client').textContent = data.client.name || '未命名应用';
    $('redirect').textContent = new URL(data.redirect_uri).origin;
    $('scope').textContent = data.scope || '未请求额外身份信息';
    $('consent').hidden = false; status('请核对账号、申请应用和连接范围，再决定是否授权。');
  }
  $('login').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; lock(true);
    try {
      const { error } = await db.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
      $('password').value = '';
      if (error) throw Error('登录失败，请检查邮箱和密码。');
      await loadConsent();
    } catch (e) { status(e.message, true); } finally { lock(false); }
  });
  async function decide(approve) {
    if (busy || !clientId) return; lock(true);
    try {
      if (approve && !(await allowed(clientId))) throw Error('连接已停用或账号无权限。');
      if (existingRedirect) {
        if (approve) { location.assign(callback(existingRedirect)); return; }
        const { error } = await db.auth.oauth.revokeGrant({ clientId });
        if (error) throw Error('撤销未完成，请稍后重试。');
        existingRedirect = null; clientId = null;
        $('consent').hidden = true;
        status('已撤销此应用的授权。需要连接时，请回到 ChatGPT 发起新的连接请求。');
        lock(false); return;
      }
      const { data, error } = approve
        ? await db.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
        : await db.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
      if (error || !data?.redirect_url) throw Error('授权请求未完成，请重新连接。');
      location.assign(callback(data.redirect_url));
    } catch (e) { status(e.message, true); lock(false); }
  }
  $('approve').addEventListener('click', () => decide(true));
  $('deny').addEventListener('click', () => decide(false));
  $('signout').addEventListener('click', async () => {
    if (busy) return; lock(true);
    try { await db.auth.signOut({ scope: 'local' }); clientId=null; existingRedirect=null; $('consent').hidden=true; $('signout').hidden=true; $('login').hidden=false; status('已退出此授权页。'); }
    finally { lock(false); }
  });
  loadConsent().catch(e => status(e.message,true));
})();
