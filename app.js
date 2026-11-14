const STORAGE_KEY = 'macbook-flip-listings-v1';
const RATE_URL = 'https://api.frankfurter.dev/v1/latest?base=CNY&symbols=SGD';
const LISTINGS_URL = './listings.json';
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
let listings = loadListings();
let cnyToSgd = null;
let rateDate = '';
let rateStatus = 'loading';
let syncStatus = '正在同步巡查数据…';
const galleryIndexes = new Map();

const grid = document.querySelector('#listingGrid');
const dialog = document.querySelector('#listingDialog');
const form = document.querySelector('#listingForm');
const imageDialog = document.querySelector('#imageDialog');
const imageViewerStage = document.querySelector('#imageViewerStage');
const fullSizeImage = document.querySelector('#fullSizeImage');
const imageDimensions = document.querySelector('#imageDimensions');
const imageSizeToggle = document.querySelector('#imageSizeToggle');

function loadListings() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]').map(item => ({...item, platform:inferPlatform(item.platform, item.url)})); }
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
  const xianyuShippingCny = isXianyu(item.platform) ? 150 : 0;
  const shippingCny = fx ? xianyuShippingCny * fx : NaN;
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
  return {purchaseSgd,shippingCny,xianyuShippingCny,inspectionCny,shippingSgd,repairSgd,baseCost,low,high,profitLow,profitHigh,maxBuyCny,decision,rate};
}
function isXianyu(platform='') { return /闲鱼|xianyu|goofish/i.test(String(platform)); }
function inferPlatform(platform, url='') {
  if (/carousell/i.test(`${platform} ${url}`)) return 'Carousell';
  if (/闲鱼|xianyu|goofish/i.test(`${platform} ${url}`)) return '闲鱼';
  return platform || '闲鱼';
}
function listingKey(item) { return String(item.id || item.itemId || item.goodsId || item.url || item.link || `${item.description || item.title || ''}|${item.priceCny || item.price || ''}`); }
function normalizeFeedItem(raw) {
  const item = {...raw};
  item.id = listingKey(item);
  item.url = item.url || item.link || item.itemUrl || item.detailUrl || '';
  item.description = item.description || item.title || item.rawDescription || item.name || '未命名商品';
  const rawImages = item.images || item.imageUrls || item.pictures || item.pics || [];
  const imageList = (Array.isArray(rawImages) ? rawImages : [rawImages])
    .concat(item.image || item.imageUrl || item.picUrl || item.cover || item.coverUrl || [])
    .map(image => typeof image === 'string' ? image : (image?.url || image?.src || image?.imageUrl || ''))
    .map(image => image.trim()).filter(Boolean);
  item.images = [...new Set(imageList)].slice(0, 10);
  item.image = item.images[0] || '';
  item.seller = item.seller || item.sellerInfo || item.nickname || item.username || '';
  item.priceCny = Number(item.priceCny ?? item.price ?? item.amount ?? 0);
  item.platform = inferPlatform(item.platform || item.source || item.marketplace || '', item.url);
  item.syncManaged = true;
  item.createdAt = Number(item.createdAt || item.created_at || Date.now());
  return item;
}
function preserveAnalysis(incoming, existing) {
  if (!existing) return incoming;
  const fields = ['saleLow','saleHigh','sampleCount','soldSource','shippingSgd','repairSgd','feePercent','targetProfit'];
  for (const field of fields) if (existing[field] !== undefined && existing[field] !== '') incoming[field] = existing[field];
  incoming.createdAt = existing.createdAt || incoming.createdAt;
  return incoming;
}
function updateSyncText(text) {
  syncStatus = text;
  const element = document.querySelector('#syncText');
  if (element) element.textContent = text;
}
function openImageViewer(src, alt) {
  imageViewerStage.classList.remove('actual-size');
  fullSizeImage.classList.remove('actual-size');
  fullSizeImage.src = src;
  fullSizeImage.alt = alt || '商品原图';
  imageDimensions.textContent = '正在读取图片尺寸…';
  imageSizeToggle.textContent = '查看原尺寸（100%）';
  imageDialog.showModal();
}
function toggleImageSize() {
  const actualSize = imageViewerStage.classList.toggle('actual-size');
  fullSizeImage.classList.toggle('actual-size', actualSize);
  imageSizeToggle.textContent = actualSize ? '适应窗口' : '查看原尺寸（100%）';
}
async function syncListings() {
  updateSyncText('正在同步巡查数据…');
  try {
    const response = await fetch(`${LISTINGS_URL}?_=${Date.now()}`, {cache:'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload : (payload.listings || payload.items || payload.results || []);
    if (!Array.isArray(rows)) throw new Error('listings.json 格式应为数组或包含 listings/items/results 数组');
    const currentByKey = new Map(listings.map(item => [listingKey(item), item]));
    const synced = rows.filter(item => item && typeof item === 'object').map(raw => {
      const normalized = normalizeFeedItem(raw);
      return preserveAnalysis(normalized, currentByKey.get(listingKey(normalized)));
    });
    const manual = listings.filter(item => !item.syncManaged);
    listings = [...manual, ...synced];
    saveListings();
    const time = new Intl.DateTimeFormat('zh-SG', {hour:'2-digit',minute:'2-digit'}).format(new Date());
    updateSyncText(`已同步 ${synced.length} 条 · ${time}`);
    render();
    return true;
  } catch (error) {
    console.error('巡查数据同步失败', error);
    updateSyncText('巡查数据同步失败 · 稍后重试');
    return false;
  }
}
function spec(label, value) { return `<div><div class="spec-label">${label}</div><div class="spec-value">${esc(value || '—')}</div></div>`; }
function renderCard(item) {
  const c = calc(item);
  const labels = {green:'可以买',yellow:'谨慎评估',red:'建议不买'};
  const decision = rateStatus === 'error' ? 'yellow' : c.decision;
  const sold = safeUrl(item.soldSource);
  const listing = safeUrl(item.url);
  const platformLabel = item.platform || '未注明平台';
  const platformClass = item.platform === 'Carousell' ? 'carousell' : item.platform === '闲鱼' ? 'xianyu' : 'other';
  const images = (Array.isArray(item.images) ? item.images : [item.image])
    .map(image => safeUrl(typeof image === 'string' ? image : (image?.url || image?.src || '')))
    .filter(Boolean).slice(0, 10);
  const galleryIndex = images.length ? ((galleryIndexes.get(item.id) || 0) % images.length) : 0;
  const image = images[galleryIndex];
  const totalFeeLow = Number.isFinite(c.baseCost) ? c.baseCost + c.low*c.rate : NaN;
  const totalFeeHigh = Number.isFinite(c.baseCost) ? c.baseCost + c.high*c.rate : NaN;
  return `<article class="listing-card" data-id="${esc(item.id)}">
    ${image ? `<div class="card-cover"><button type="button" class="card-image-button" data-image-open data-image-src="${esc(image)}" data-image-alt="${esc(`${item.description || 'MacBook 商品图片'} · 图片 ${galleryIndex + 1}`)}" aria-label="查看原图：${esc(item.description || 'MacBook 商品图片')}"><img src="${esc(image)}" alt="${esc(item.description || 'MacBook 商品图片')} · 图片 ${galleryIndex + 1}" loading="lazy" onerror="this.closest('.card-cover').classList.add('image-error');this.closest('.card-image-button').remove()"></button><span class="image-open-hint" aria-hidden="true">查看原图 ↗</span>${images.length > 1 ? `<div class="gallery-controls"><span class="gallery-count">${galleryIndex + 1} / ${images.length}</span><div class="gallery-arrows"><button type="button" class="gallery-button" data-gallery-step="-1" data-id="${esc(item.id)}" aria-label="上一张图片">‹</button><button type="button" class="gallery-button" data-gallery-step="1" data-id="${esc(item.id)}" aria-label="下一张图片">›</button></div></div>` : ''}</div>` : ''}
    <div class="card-content">
      <div class="platform-row"><span class="platform-badge ${platformClass}">${esc(platformLabel)}</span></div>
      <div class="card-heading"><h2>${esc(item.description || '未命名商品')}</h2><span class="decision ${decision}">${labels[decision]}</span></div>
      <p class="seller-line">卖家：${esc(item.seller || '未填写')}</p>
      ${listing?`<a class="product-link" href="${esc(listing)}" target="_blank" rel="noopener"><span class="product-link-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M13.5 6H18v4.5M18 6l-8 8"/><path d="M17 13v5H6V7h5"/></svg></span><span class="product-link-copy"><strong>打开商品页面</strong><small>${esc(new URL(listing).hostname)}</small></span><span class="product-link-arrow" aria-hidden="true">↗</span></a>`:''}
      <div class="profit-panel"><div class="profit-top"><span class="profit-label">预计利润区间</span><strong class="profit-amount ${c.profitLow>=0?'pos':'neg'}">${money(c.profitLow)} – ${money(c.profitHigh)}</strong></div><div class="profit-sub"><span>按已成交样本估算 · ${esc(item.sampleCount || 1)} 个样本</span><span>售价 ${money(c.low)} – ${money(c.high)}</span></div></div>
      <section class="detail-section"><h3 class="section-title">机器信息</h3><div class="spec-grid">${spec('平台',item.platform)}${spec('尺寸',item.size)}${spec('芯片',item.chip)}${spec('内存',item.memory)}${spec('硬盘',item.storage)}${spec('电池健康',item.battery)}${spec('循环次数',item.cycles ? `${item.cycles} 次` : '')}${spec('成色',item.condition)}${spec('保修',item.warranty)}</div></section>
      <section class="detail-section"><h3 class="section-title">费用明细 · 新币</h3><div class="cost-list">
        <div class="cost-row"><span>商品价格 · ¥${Number(item.priceCny||0).toLocaleString('zh-CN')} × 汇率</span><span>${money(c.purchaseSgd)}</span></div>
        <div class="cost-row"><span>${isXianyu(item.platform)?'闲鱼运费 · ¥150 × 汇率':'闲鱼运费 · Carousell 不适用'}</span><span>${money(c.shippingCny)}</span></div>
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
  const defaults={platform:'闲鱼',shippingSgd:35,repairSgd:0,feePercent:0,targetProfit:150,sampleCount:1};
  const formItem = item ? {...item, images: (Array.isArray(item.images) ? item.images : (item.image ? [item.image] : [])).slice(0, 10).join('\n')} : {};
  for (const [key,value] of Object.entries({...defaults,...formItem})) {
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
document.querySelector('#syncNow').addEventListener('click', async event => {
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add('syncing');
  button.querySelector('span').textContent = '正在同步…';
  updateSyncText('正在从 GitHub 获取最新巡查数据…');
  try {
    const result = window.macbookFlip?.syncLatestListings
      ? await window.macbookFlip.syncLatestListings()
      : {ok: true};
    if (!result.ok) {
      const message = /empty|空/i.test(result.message || '')
        ? 'GitHub 暂无巡查数据，本机数据已保留'
        : '同步失败，本机数据已保留';
      updateSyncText(message);
      toast(message);
      return;
    }
    const synced = await syncListings();
    toast(synced ? '已完成最新巡查数据同步' : '同步失败，本机数据已保留');
  } catch (error) {
    console.error('手动同步失败', error);
    updateSyncText('同步失败，本机数据已保留');
    toast('同步失败，本机数据已保留');
  } finally {
    button.disabled = false;
    button.classList.remove('syncing');
    button.querySelector('span').textContent = '同步巡查';
  }
});
document.querySelector('.rate-pill').addEventListener('click',()=>{if(rateStatus==='error')fetchRate();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible') syncListings();});
grid.addEventListener('click',event=>{
  const imageOpen=event.target.closest('[data-image-open]');
  if(imageOpen){openImageViewer(imageOpen.dataset.imageSrc,imageOpen.dataset.imageAlt);return;}
  const gallery=event.target.closest('.gallery-button');
  if(gallery){
    const item=listings.find(x=>x.id===gallery.dataset.id);
    const count=(Array.isArray(item?.images)?item.images:(item?.image?[item.image]:[])).length;
    if(item&&count>1){galleryIndexes.set(item.id,((galleryIndexes.get(item.id)||0)+Number(gallery.dataset.galleryStep)+count)%count);render();}
    return;
  }
  const edit=event.target.closest('.edit-button');
  const remove=event.target.closest('.delete-button');
  if(edit){const item=listings.find(x=>x.id===edit.dataset.id);if(item)openForm(item);}
  if(remove){listings=listings.filter(x=>x.id!==remove.dataset.id);saveListings();render();}
});
imageSizeToggle.addEventListener('click',toggleImageSize);
fullSizeImage.addEventListener('click',toggleImageSize);
fullSizeImage.addEventListener('load',()=>{imageDimensions.textContent=`${fullSizeImage.naturalWidth} × ${fullSizeImage.naturalHeight} px`;});
document.querySelector('#closeImageViewer').addEventListener('click',()=>imageDialog.close());
imageDialog.addEventListener('click',event=>{if(event.target===imageDialog)imageDialog.close();});
imageDialog.addEventListener('close',()=>{fullSizeImage.removeAttribute('src');});
form.addEventListener('submit',event=>{
  event.preventDefault();
  const data=Object.fromEntries(new FormData(form).entries());
  const enteredImages=String(data.images||'').split(/\r?\n/).map(url=>url.trim()).filter(Boolean);
  if(enteredImages.length>10){toast('每台机器最多录入 10 张图片');return;}
  data.images=[...new Set(enteredImages)]; data.image=data.images[0]||'';
  delete data.imagesText;
  for(const key of ['priceCny','saleLow','saleHigh','sampleCount','cycles','shippingSgd','repairSgd','feePercent','targetProfit']) data[key]=data[key]===''?0:Number(data[key]);
  if(data.saleLow>data.saleHigh){toast('成交低价不能高于高价');return;}
  const index=listings.findIndex(item=>item.id===data.id);
  data.id=data.id||crypto.randomUUID(); data.createdAt=index>=0?listings[index].createdAt:Date.now(); data.syncManaged=index>=0?!!listings[index].syncManaged:false;
  if(index>=0)listings[index]=data;else listings.push(data);
  saveListings();render();dialog.close();
});
function toast(message){const el=document.createElement('div');el.className='toast';el.textContent=message;document.body.append(el);setTimeout(()=>el.remove(),2200);}
render(); fetchRate(); syncListings(); setInterval(syncListings, SYNC_INTERVAL_MS);
