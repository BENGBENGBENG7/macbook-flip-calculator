const STORAGE_KEY = 'macbook-flip-listings-v1';
const RATE_URL = 'https://api.frankfurter.dev/v1/latest?base=CNY&symbols=SGD';
let listings = loadListings();
let cnyToSgd = null;
let rateDate = '';
let rateStatus = 'loading';

const grid = document.querySelector('#listingGrid');
const dialog = document.querySelector('#listingDialog');
const form = document.querySelector('#listingForm');

function loadListings() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}
function saveListings() { localStorage.setItem(STORAGE_KEY, JSON.stringify(listings)); }
function esc(value='') { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function money(value, currency='SGD') {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-SG', {style:'currency',currency,maximumFractionDigits:0}).format(value);
}
function safeUrl(value) {
  try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
}
function calc(item) {
  const fx = cnyToSgd;
  const purchaseSgd = fx ? (Number(item.priceCny)||0) * fx : NaN;
  const shippingCny = fx ? 150 * fx : NaN;
  const inspectionCny = fx ? 54 * fx : NaN;
  const shippingSgd = Number(item.shippingSgd)||0;
  const repairSgd = Number(item.repairSgd)||0;
  const rate = (Number(item.feePercent)||0)/100;
  const baseCost = purchaseSgd + shippingCny + inspectionCny + shippingSgd + repairSgd;
  const low = Number(item.saleLow)||0, high = Number(item.saleHigh)||0;
  const profitLow = low*(1-rate)-baseCost;
  const profitHigh = high*(1-rate)-baseCost;
  const target = Number(item.targetProfit)||0;
  const maxPurchaseSgd = (low*(1-rate)-shippingCny-inspectionCny-shippingSgd-repairSgd-target);
  const maxBuyCny = fx ? maxPurchaseSgd/fx : NaN;
  let decision = 'yellow';
  if (Number.isFinite(profitHigh) && profitHigh <= 0) decision = 'red';
  else if (Number.isFinite(profitLow) && profitLow > 0 && (Number(item.sampleCount)||0) >= 2) decision = 'green';
  return {purchaseSgd,shippingCny,inspectionCny,shippingSgd,repairSgd,baseCost,low,high,profitLow,profitHigh,maxBuyCny,decision,rate};
}
function spec(label, value) { return `<div><div class="spec-label">${label}</div><div class="spec-value">${esc(value || '—')}</div></div>`; }
function renderCard(item) {
  const c = calc(item);
  const labels = {green:'可以买',yellow:'谨慎评估',red:'建议不买'};
  const decision = rateStatus === 'error' ? 'yellow' : c.decision;
  const sold = safeUrl(item.soldSource);
  const listing = safeUrl(item.url);
  const image = safeUrl(item.image);
  const totalFeeLow = Number.isFinite(c.baseCost) ? c.baseCost + c.low*c.rate : NaN;
  const totalFeeHigh = Number.isFinite(c.baseCost) ? c.baseCost + c.high*c.rate : NaN;
  return `<article class="listing-card" data-id="${esc(item.id)}">
    <div class="card-cover">${image ? `<img src="${esc(image)}" alt="${esc(item.description)}" loading="lazy" onerror="this.remove()">` : '<span class="image-placeholder">MACBOOK PRO</span>'}${listing?`<a class="cover-link" href="${esc(listing)}" target="_blank" rel="noopener" title="打开商品链接">↗</a>`:''}</div>
    <div class="card-content">
      <div class="card-heading"><h2>${esc(item.description || '未命名商品')}</h2><span class="decision ${decision}">${labels[decision]}</span></div>
      <p class="seller-line">卖家：${esc(item.seller || '未填写')}${listing?` · <a href="${esc(listing)}" target="_blank" rel="noopener">查看商品 ↗</a>`:''}</p>
      <div class="profit-panel"><div class="profit-top"><span class="profit-label">预计利润区间</span><strong class="profit-amount ${c.profitLow>=0?'pos':'neg'}">${money(c.profitLow)} – ${money(c.profitHigh)}</strong></div><div class="profit-sub"><span>按已成交样本估算 · ${esc(item.sampleCount || 1)} 个样本</span><span>售价 ${money(c.low)} – ${money(c.high)}</span></div></div>
      <section class="detail-section"><h3 class="section-title">机器信息</h3><div class="spec-grid">${spec('尺寸',item.size)}${spec('芯片',item.chip)}${spec('内存',item.memory)}${spec('硬盘',item.storage)}${spec('电池健康',item.battery)}${spec('循环次数',item.cycles ? `${item.cycles} 次` : '')}${spec('成色',item.condition)}${spec('保修',item.warranty)}</div></section>
      <section class="detail-section"><h3 class="section-title">费用明细 · 新币</h3><div class="cost-list">
        <div class="cost-row"><span>商品价格 · ¥${Number(item.priceCny||0).toLocaleString('zh-CN')} × 汇率</span><span>${money(c.purchaseSgd)}</span></div>
        <div class="cost-row"><span>闲鱼运费 · ¥150 × 汇率</span><span>${money(c.shippingCny)}</span></div>
        <div class="cost-row"><span>验货宝 · ¥54 × 汇率</span><span>${money(c.inspectionCny)}</span></div>
        <div class="cost-row"><span>跨境运输</span><span>${money(c.shippingSgd)}</span></div>
        <div class="cost-row"><span>维修 / 整备</span><span>${money(c.repairSgd)}</span></div>
        <div class="cost-row"><span>平台费 · ${(Number(item.feePercent)||0).toFixed(1)}%（随成交价变化）</span><span>${money(c.low*c.rate)} – ${money(c.high*c.rate)}</span></div>
        <div class="cost-row total"><span>预计总成本（含平台费）</span><span>${money(totalFeeLow)} – ${money(totalFeeHigh)}</span></div>
      </div><p class="price-source"><b>成交参考：</b>${sold?`<a class="sold-source" href="${esc(sold)}" target="_blank" rel="noopener">${esc(item.soldSource)} ↗</a>`:esc(item.soldSource || '请填写已成交记录来源')}<br>请使用近期同配置真实成交记录；工具按录入区间估算，不抓取平台在售标价。</p></section>
      <div class="card-footer"><div class="max-buy"><small>最高建议买价 · 含目标利润 ${money(Number(item.targetProfit)||0)}</small><strong>${money(c.maxBuyCny,'CNY')}</strong></div><div class="card-actions"><button class="quiet-button edit-button" data-id="${esc(item.id)}">编辑</button><button class="quiet-button delete delete-button" data-id="${esc(item.id)}">删除</button></div></div>
    </div>
  </article>`;
}
function render() {
  const sort = document.querySelector('#sortMode').value;
  const sorted = [...listings].sort((a,b) => sort === 'date' ? b.createdAt-a.createdAt : calc(b).profitLow-calc(a).profitLow);
  grid.innerHTML = sorted.map(renderCard).join('');
  document.querySelector('#listingCount').textContent = `${listings.length} 台商品`;
  document.querySelector('#emptyState').classList.toggle('visible', listings.length===0);
}
function updateRateText() {
  const el = document.querySelector('#rateText');
  if (rateStatus==='loading') el.textContent='正在获取汇率…';
  else if (rateStatus==='error') el.textContent='汇率获取失败 · 点此重试';
  else el.textContent=`1 CNY = ${cnyToSgd.toFixed(4)} SGD · ${rateDate}`;
}
async function fetchRate() {
  rateStatus='loading'; updateRateText();
  try {
    const response = await fetch(RATE_URL, {cache:'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.rates?.SGD || !data.date) throw new Error('汇率数据格式不正确');
    cnyToSgd=data.rates.SGD; rateDate=data.date; rateStatus='ok';
  } catch (error) { rateStatus='error'; console.error('汇率加载失败',error); }
  updateRateText(); render();
}
function openForm(item) {
  form.reset();
  document.querySelector('#listingId').value=item?.id||'';
  document.querySelector('#dialogTitle').textContent=item?'编辑商品':'添加商品';
  const defaults={shippingSgd:35,repairSgd:0,feePercent:0,targetProfit:150,sampleCount:1};
  for (const [key,value] of Object.entries({...defaults,...(item||{})})) {
    const input=form.elements.namedItem(key);
    if(input) input.value=value ?? '';
  }
  dialog.showModal();
}
document.querySelector('#addListing').addEventListener('click',()=>openForm());
document.querySelector('#addFirst').addEventListener('click',()=>openForm());
document.querySelector('#closeDialog').addEventListener('click',()=>dialog.close());
document.querySelector('#cancelDialog').addEventListener('click',()=>dialog.close());
document.querySelector('#sortMode').addEventListener('change',render);
document.querySelector('#refreshRate').addEventListener('click',fetchRate);
document.querySelector('.rate-pill').addEventListener('click',()=>{if(rateStatus==='error')fetchRate();});
grid.addEventListener('click',event=>{
  const edit=event.target.closest('.edit-button');
  const remove=event.target.closest('.delete-button');
  if(edit){const item=listings.find(x=>x.id===edit.dataset.id);if(item)openForm(item);}
  if(remove){listings=listings.filter(x=>x.id!==remove.dataset.id);saveListings();render();}
});
form.addEventListener('submit',event=>{
  event.preventDefault();
  const data=Object.fromEntries(new FormData(form).entries());
  for(const key of ['priceCny','saleLow','saleHigh','sampleCount','cycles','shippingSgd','repairSgd','feePercent','targetProfit']) data[key]=data[key]===''?0:Number(data[key]);
  if(data.saleLow>data.saleHigh){toast('成交低价不能高于高价');return;}
  const index=listings.findIndex(item=>item.id===data.id);
  data.id=data.id||crypto.randomUUID(); data.createdAt=index>=0?listings[index].createdAt:Date.now();
  if(index>=0)listings[index]=data;else listings.push(data);
  saveListings();render();dialog.close();
});
function toast(message){const el=document.createElement('div');el.className='toast';el.textContent=message;document.body.append(el);setTimeout(()=>el.remove(),2200);}
render(); fetchRate();
