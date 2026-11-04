(()=>{
const defaults={ink:'#305f42',soft:'#e6ecdf',wash:'#faf9f4'};
const date=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const key='ledger.daily.palette.v1'; let day='',revision=0;
function valid(x){return x?.date===date()&&['ink','soft','wash'].every(k=>/^#[0-9a-f]{6}$/i.test(x.colors?.[k]))}
function paint(c){for(const k of Object.keys(defaults))document.documentElement.style.setProperty('--theme-'+k,c[k]);document.querySelector('meta[name="theme-color"]').content=c.ink}
async function refresh(){
 const seq=++revision;day=date();let cached;try{cached=JSON.parse(localStorage.getItem(key))}catch{}
 paint(valid(cached)?cached.colors:defaults);
 try{const r=await fetch('https://raw.githubusercontent.com/taba91659-hub/wangye/main/theme/daily.json',{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(7000)});if(!r.ok)return;const v=await r.json();if(seq!==revision||day!==date())return;paint(valid(v)?v.colors:defaults);try{localStorage.setItem(key,JSON.stringify(v))}catch{}}catch{}
}
refresh();setInterval(()=>{if(day!==date()&&!document.hidden)refresh()},30000);setInterval(()=>{if(!document.hidden)refresh()},3600000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()})
})();
