const STORAGE_KEY = 'macbook-flip-listings-v1';
const LISTINGS_DB_NAME = 'macbook-flip-local-cache';
const LISTINGS_DB_STORE = 'snapshots';
const USER_DELETED_IDS_KEY = 'macbook-flip-user-deleted-listings-v1';
const RATE_CACHE_KEY = 'macbook-flip-cny-sgd-rate-v1';
const PLATFORM_FILTER_KEY = 'macbook-flip-platform-filter-v1';
const SORT_MODE_KEY = 'macbook-flip-sort-mode-v1';
const CLOUD_DATA_CACHE_KEY = 'macbook-flip-cloud-data-v1';
const RATE_URL = 'https://api.frankfurter.dev/v1/latest?base=CNY&symbols=SGD';
const LISTINGS_URL = './listings.json';
const DELETED_LISTINGS_URL = './deleted-listings.json';
const CLOUD_DATA_URL = 'https://bengbengbeng7.github.io/macbook-flip-calculator/user-data.json';
const CLOUD_DATA_PATH = 'user-data.json';
const GITHUB_API_ROOT = 'https://api.github.com/repos/BENGBENGBENG7/macbook-flip-calculator';
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const ANALYSIS_FIELDS = ['saleLow','saleHigh','sampleCount','soldSource','shippingSgd','repairSgd','feePercent','targetProfit'];
const VALID_SORT_MODES = new Set(['profit','recommend','ask','date']);
const VALID_PLATFORMS = new Set(['all','xianyu','carousell']);
function loadRateCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(RATE_CACHE_KEY)||'null');
    return cached && Number(cached.rate)>0 ? {rate:Number(cached.rate),date:String(cached.date||'')} : null;
  } catch { return null; }
}
const cachedRate = loadRateCache();
let listings = loadListings();
let cnyToSgd = cachedRate?.rate || null;
let rateDate = cachedRate?.date || '';
let rateStatus = cachedRate ? 'cached' : 'loading';
let syncStatus = '正在同步巡查数据…';
let selectedListingId = null;
let githubToken = '';
let pendingDeleteId = null;
let githubTokenLoading = true;
let feedScrollY = 0;
const galleryIndexes = new Map();
let cloudUserData = loadCloudUserDataCache();
let currentPlatformFilter = loadStoredValue(PLATFORM_FILTER_KEY, VALID_PLATFORMS, 'all');
let currentSortMode = loadStoredValue(SORT_MODE_KEY, VALID_SORT_MODES, 'profit');

const grid = document.querySelector('#listingGrid');
const dialog = document.querySelector('#listingDialog');
const form = document.querySelector('#listingForm');
const imageDialog = document.querySelector('#imageDialog');
const imageViewerStage = document.querySelector('#imageViewerStage');
const fullSizeImage = document.querySelector('#fullSizeImage');
const imageDimensions = document.querySelector('#imageDimensions');
const imageSizeToggle = document.querySelector('#imageSizeToggle');
const imageCounter = document.querySelector('#imageCounter');
const previousViewerImage = document.querySelector('#previousViewerImage');
const nextViewerImage = document.querySelector('#nextViewerImage');
let viewerImages = [];
let viewerIndex = 0;
let viewerDescription = '商品原图';

function loadListings() {
  try {
    const deletedIds = loadUserDeletedIds();
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]').filter(item => !deletedIds.has(listingKey(item))).map(item => ({
      ...item,
      platform: inferPlatform(item.platform, item.url),
      ...(item.syncManaged ? {firstSeenAt: timestamp(item.firstSeenAt || item.createdAt || item.created_at, Date.now())} : {})
    }));
  }
  catch { return []; }
}
function openListingsCache() {
  return new Promise((resolve,reject)=>{
    if(!window.indexedDB){reject(new Error('IndexedDB 不可用'));return;}
    const request=indexedDB.open(LISTINGS_DB_NAME,1);
    request.onupgradeneeded=()=>request.result.createObjectStore(LISTINGS_DB_STORE);
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error||new Error('本机缓存数据库打开失败'));
  });
}
async function saveListingsToIndexedDB(serialized) {
  const db=await openListingsCache();
  await new Promise((resolve,reject)=>{
    const transaction=db.transaction(LISTINGS_DB_STORE,'readwrite');
    transaction.objectStore(LISTINGS_DB_STORE).put(serialized,STORAGE_KEY);
    transaction.oncomplete=resolve;
    transaction.onerror=()=>reject(transaction.error||new Error('本机缓存写入失败'));
    transaction.onabort=()=>reject(transaction.error||new Error('本机缓存写入已取消'));
  }).finally(()=>db.close());
}
async function readListingsFromIndexedDB() {
  const db=await openListingsCache();
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction(LISTINGS_DB_STORE,'readonly');
    const request=transaction.objectStore(LISTINGS_DB_STORE).get(STORAGE_KEY);
    request.onsuccess=()=>resolve(request.result||'');
    request.onerror=()=>reject(request.error||new Error('本机缓存读取失败'));
    transaction.oncomplete=()=>db.close();
    transaction.onerror=()=>{db.close();reject(transaction.error||new Error('本机缓存读取失败'));};
  });
}
function saveListings() {
  const serialized=JSON.stringify(listings);
  try { localStorage.setItem(STORAGE_KEY,serialized); }
  catch(error) {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    void saveListingsToIndexedDB(serialized).catch(cacheError=>console.warn('IndexedDB 巡查缓存写入失败',cacheError));
  }
}
async function restoreListingsFromIndexedDB() {
  try {
    const serialized=await readListingsFromIndexedDB();
    if(listings.length||!serialized)return;
    const cached=JSON.parse(serialized);
    if(!Array.isArray(cached))return;
    const deletedIds=loadUserDeletedIds();
    listings=cached.filter(item=>item&&typeof item==='object'&&!deletedIds.has(listingKey(item))).map(item=>({...item,platform:inferPlatform(item.platform,item.url)}));
    render();
  } catch(error) { console.warn('IndexedDB 巡查缓存读取失败',error); }
}
function loadUserDeletedIds() {
  try {
    const ids = JSON.parse(localStorage.getItem(USER_DELETED_IDS_KEY) || '[]');
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch { return new Set(); }
}
function saveUserDeletedIds(ids) { localStorage.setItem(USER_DELETED_IDS_KEY, JSON.stringify([...ids])); }
function makeDataBackup() {
  return {
    format: 'macbook-flip-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    listings,
    userDeletedIds: [...loadUserDeletedIds()],
    rateCache: loadRateCache(),
  };
}
async function exportDataBackup() {
  const contents = `${JSON.stringify(makeDataBackup(), null, 2)}\n`;
  const filename = `Macbook-flip-backup-${new Date().toISOString().slice(0, 10)}.json`;
  if (window.macbookFlip?.saveBackup) {
    const result = await window.macbookFlip.saveBackup(contents, filename);
    if (result?.canceled) return;
    if (!result?.ok) throw new Error('备份文件保存失败');
    toast(`已导出备份：${result.filePath}`);
    return;
  }
  const url = URL.createObjectURL(new Blob([contents], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('备份已下载，请保存到新电脑或云盘');
}
function importDataBackup(backup) {
  if (backup?.format !== 'macbook-flip-backup' || backup.version !== 1 || !Array.isArray(backup.listings)) {
    throw new Error('备份格式不正确或版本不支持');
  }
  const deletedIds = loadUserDeletedIds();
  for (const id of Array.isArray(backup.userDeletedIds) ? backup.userDeletedIds : []) deletedIds.add(String(id));
  saveUserDeletedIds(deletedIds);
  const merged = new Map(listings.map(item => [listingKey(item), item]));
  for (const item of backup.listings) {
    if (!item || typeof item !== 'object') continue;
    const key = listingKey(item);
    if (!deletedIds.has(key)) merged.set(key, {...item, id: key, ...(item.syncManaged?{analysisUpdatedAt:Date.now()}:{cloudUpdatedAt:Date.now()})});
  }
  listings = [...merged.values()].filter(item => !deletedIds.has(listingKey(item)));
  saveListings();
  if (backup.rateCache && Number(backup.rateCache.rate) > 0) {
    localStorage.setItem(RATE_CACHE_KEY, JSON.stringify(backup.rateCache));
    cnyToSgd = Number(backup.rateCache.rate);
    rateDate = String(backup.rateCache.date || '');
    rateStatus = 'cached';
    updateRateText();
  }
  render();
}
async function loadGithubToken() {
  try {
    githubToken = window.macbookFlip?.getGithubToken
      ? await window.macbookFlip.getGithubToken()
      : sessionStorage.getItem('macbook-flip-github-token') || '';
  } catch { githubToken = ''; }
  githubTokenLoading = false;
  updateGithubAuthButton();
}
function updateGithubAuthButton() {
  const label = document.querySelector('#githubAuthText');
  const button = document.querySelector('#githubAuthButton');
  if (label) label.textContent = githubToken ? '云端写入已授权' : '云端写入授权';
  if (button) button.classList.toggle('connected', !!githubToken);
}
async function storeGithubToken(token) {
  if (window.macbookFlip?.setGithubToken) await window.macbookFlip.setGithubToken(token);
  else sessionStorage.setItem('macbook-flip-github-token', token);
  githubToken = token;
  updateGithubAuthButton();
}
async function clearGithubToken() {
  if (window.macbookFlip?.clearGithubToken) await window.macbookFlip.clearGithubToken();
  else sessionStorage.removeItem('macbook-flip-github-token');
  githubToken = '';
  updateGithubAuthButton();
}
async function githubRequest(endpoint, options={}) {
  const response = await fetch(`${GITHUB_API_ROOT}${endpoint}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? {'Content-Type':'application/json'} : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${body.message || response.statusText}`);
  return body;
}
async function readGithubJson(path, ref='main', allowMissing=false) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  try {
    let file;
    try { file=await githubRequest(`/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`); }
    catch (error) {
      if(/GitHub 404:/.test(error.message)) throw error;
      const commit=await githubRequest(`/commits/${encodeURIComponent(ref)}`);
      const tree=await githubRequest(`/git/trees/${encodeURIComponent(commit.commit.tree.sha)}?recursive=1`);
      file=tree.tree.find(entry=>entry.path===path);
      if(!file?.sha)throw error;
    }
    let encoded=String(file.content||'').replace(/\s/g,'');
    if(!encoded&&file.sha){
      const blob=await githubRequest(`/git/blobs/${encodeURIComponent(file.sha)}`);
      encoded=String(blob.content||'').replace(/\s/g,'');
    }
    const bytes = Uint8Array.from(atob(encoded), char=>char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (allowMissing && /GitHub 404:/.test(error.message)) return null;
    throw error;
  }
}
async function commitGithubMutation(message, makeFiles) {
  for (let attempt=0; attempt<3; attempt+=1) {
    try {
      const ref = await githubRequest('/git/ref/heads/main');
      const parentSha = ref.object.sha;
      const head = await githubRequest(`/git/commits/${parentSha}`);
      const files = await makeFiles(parentSha);
      const entries = await Promise.all(Object.entries(files).map(async ([path,content]) => {
        const blob = await githubRequest('/git/blobs',{method:'POST',body:JSON.stringify({content,encoding:'utf-8'})});
        return {path,mode:'100644',type:'blob',sha:blob.sha};
      }));
      const tree = await githubRequest('/git/trees',{method:'POST',body:JSON.stringify({base_tree:head.tree.sha,tree:entries})});
      const commit = await githubRequest('/git/commits',{method:'POST',body:JSON.stringify({message,tree:tree.sha,parents:[parentSha]})});
      await githubRequest('/git/refs/heads/main',{method:'PATCH',body:JSON.stringify({sha:commit.sha,force:false})});
      return commit.sha;
    } catch (error) {
      if (!/GitHub (409|422):/.test(error.message) || attempt===2) throw error;
    }
  }
}
function normalizeCloudUserData(value) {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    schemaVersion: 1,
    updatedAt: String(data.updatedAt || ''),
    analysisById: data.analysisById && typeof data.analysisById === 'object' && !Array.isArray(data.analysisById) ? data.analysisById : {},
    manualListings: Array.isArray(data.manualListings) ? data.manualListings.filter(item=>item&&typeof item==='object') : [],
    userDeletedIds: [...new Set((Array.isArray(data.userDeletedIds)?data.userDeletedIds:[]).map(String))],
  };
}
function loadCloudUserDataCache() {
  try { return normalizeCloudUserData(JSON.parse(localStorage.getItem(CLOUD_DATA_CACHE_KEY)||'{}')); }
  catch { return normalizeCloudUserData({}); }
}
function saveCloudUserDataCache(data) {
  cloudUserData=normalizeCloudUserData(data);
  try { localStorage.setItem(CLOUD_DATA_CACHE_KEY,JSON.stringify(cloudUserData)); } catch {}
}
function cloudAnalysisFor(item) {
  const snapshot = {updatedAt: new Date(timestamp(item.analysisUpdatedAt,timestamp(item.createdAt,0))||Date.now()).toISOString()};
  for (const field of ANALYSIS_FIELDS) if (item[field] !== undefined) snapshot[field] = item[field];
  return snapshot;
}
function mergeCloudManualListings(cloudItems, localItems, deletedIds) {
  const merged = new Map();
  for (const item of cloudItems) {
    const id = listingKey(item);
    if (!deletedIds.has(id)) merged.set(id,{...item,id});
  }
  for (const item of localItems) {
    const id = listingKey(item);
    if (deletedIds.has(id)) continue;
    const cloud = merged.get(id);
    const cloudTime = timestamp(cloud?.cloudUpdatedAt,0);
    const localTime = timestamp(item.cloudUpdatedAt,0);
    if (!cloud || localTime > cloudTime) merged.set(id,{...item,id});
  }
  return [...merged.values()];
}
async function pushCloudChanges(changedItems) {
  if (!githubToken) {
    updateSyncText('数据已保存在本机；连接 GitHub 后可同步到云端');
    return false;
  }
  const changed = changedItems.filter(Boolean);
  const hasCloudDeletion = [...loadUserDeletedIds()].some(id=>!cloudUserData.userDeletedIds.includes(id));
  if (!changed.length && !hasCloudDeletion) return true;
  try {
    const commitSha = await commitGithubMutation('Sync Macbook flip cloud data',async parentSha=>{
      const data = normalizeCloudUserData(await readGithubJson(CLOUD_DATA_PATH,parentSha,true));
      for (const item of changed) {
        const id = listingKey(item);
        if (item.syncManaged) {
          const incoming = cloudAnalysisFor(item);
          const current = data.analysisById[id];
          if (!current || timestamp(incoming.updatedAt,0) >= timestamp(current.updatedAt,0)) data.analysisById[id] = incoming;
        } else {
          const incoming = {...item,id,cloudUpdatedAt:timestamp(item.cloudUpdatedAt,timestamp(item.createdAt,0))||Date.now()};
          const index = data.manualListings.findIndex(entry=>listingKey(entry)===id);
          if (index < 0) data.manualListings.push(incoming);
          else if (Number(incoming.cloudUpdatedAt)>timestamp(data.manualListings[index].cloudUpdatedAt,0)) data.manualListings[index]=incoming;
        }
      }
      data.userDeletedIds = [...new Set([...data.userDeletedIds,...loadUserDeletedIds()])];
      data.updatedAt = new Date().toISOString();
      saveCloudUserDataCache(data);
      return {[CLOUD_DATA_PATH]:`${JSON.stringify(data,null,2)}\n`};
    });
    updateSyncText('个人分析已同步到 GitHub 云端');
    return !!commitSha;
  } catch (error) {
    console.error('云端数据同步失败',error);
    if (/GitHub 401:/.test(error.message)) await clearGithubToken();
    updateSyncText('本机数据已保存 · 云端同步失败');
    toast('本机数据已保存，但云端同步失败；请检查 GitHub 授权');
    return false;
  }
}
function remoteRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['listings','items','results']) if (Array.isArray(payload?.[key])) return payload[key];
  throw new Error('GitHub listings.json 格式不正确');
}
function withRemoteRows(payload, rows) {
  if (Array.isArray(payload)) return rows;
  const key = ['listings','items','results'].find(name=>Array.isArray(payload?.[name])) || 'listings';
  return {...payload,[key]:rows};
}
function deletedIdsFromPayload(payload) {
  const entries = Array.isArray(payload) ? payload : payload?.deletedIds || payload?.ids || [];
  return new Set(Array.isArray(entries) ? entries.map(entry=>String(typeof entry==='object'?(entry.id||entry.listingId||''):entry)).filter(Boolean) : []);
}
async function connectGithubToken(token) {
  const previousToken = githubToken;
  githubToken = token.trim();
  try {
    await readGithubJson(CLOUD_DATA_PATH,'main',true);
    await storeGithubToken(githubToken);
  } catch {
    githubToken = previousToken;
    throw new Error('令牌无效或缺少此仓库的 Contents 读取权限。请确认授权仓库 BENGBENGBENG7/macbook-flip-calculator，且 Contents 权限为 Read and write。');
  }
}
async function commitRemoteDeletion(item) {
  const id = listingKey(item);
  await commitGithubMutation(`Remove listing ${id} from Macbook flip`,async parentSha=>{
      const listingsPayload = await readGithubJson('listings.json', parentSha);
      const deletedPayload = await readGithubJson('deleted-listings.json', parentSha, true);
      const rows = remoteRows(listingsPayload);
      const remainingRows = rows.filter(row=>listingKey(row)!==id);
      const tombstones = deletedIdsFromPayload(deletedPayload);
      tombstones.add(id);
      const cloud = normalizeCloudUserData(await readGithubJson(CLOUD_DATA_PATH,parentSha,true));
      cloud.userDeletedIds = [...new Set([...cloud.userDeletedIds,id])];
      cloud.manualListings=cloud.manualListings.filter(entry=>listingKey(entry)!==id);
      delete cloud.analysisById[id];
      cloud.updatedAt = new Date().toISOString();
      saveCloudUserDataCache(cloud);
      return {
        'listings.json': `${JSON.stringify(withRemoteRows(listingsPayload,remainingRows),null,2)}\n`,
        'deleted-listings.json': `${JSON.stringify([...tombstones],null,2)}\n`,
        [CLOUD_DATA_PATH]: `${JSON.stringify(cloud,null,2)}\n`,
      };
  });
}
function openGithubAuthDialog() {
  const tokenInput = document.querySelector('#githubTokenInput');
  const disconnect = document.querySelector('#disconnectGithub');
  if (tokenInput) tokenInput.value = '';
  if (disconnect) disconnect.hidden = !githubToken;
  document.querySelector('#githubTokenDialog').showModal();
}
async function performRemoteDelete(id) {
  const item = listings.find(entry=>entry.id===id);
  if (!item || !githubToken) return;
  try {
    updateSyncText('正在从 GitHub 删除商品…');
    await commitRemoteDeletion(item);
    const deletedIds = loadUserDeletedIds();
    deletedIds.add(listingKey(item));
    saveUserDeletedIds(deletedIds);
    listings = listings.filter(entry=>listingKey(entry)!==listingKey(item));
    selectedListingId = null;
    pendingDeleteId = null;
    saveListings();
    render();
    updateSyncText('商品已从 GitHub 删除');
    toast('已从 GitHub 删除；其他设备会在下次同步时更新');
  } catch (error) {
    console.error('GitHub 删除失败',error);
    if (/GitHub 401:/.test(error.message)) { await clearGithubToken(); }
    toast('GitHub 删除失败：请检查令牌的仓库和 Contents 写入权限');
  }
}
function timestamp(value, fallback=Date.now()) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const date = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(date) && date > 0 ? date : fallback;
}
function pruneExpiredListings() { return 0; }
function scheduleExpiryCheck() {}
function loadStoredValue(key, validValues, fallback) {
  try {
    const value = localStorage.getItem(key);
    return validValues.has(value) ? value : fallback;
  } catch { return fallback; }
}
function esc(value='') { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function money(value, currency='SGD') {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-SG', {style:'currency',currency,maximumFractionDigits:0}).format(value);
}
function amountToggle(cny, sgd, currency='SGD', className='') {
  const finiteCny = Number.isFinite(Number(cny));
  const finiteSgd = Number.isFinite(Number(sgd));
  if (!finiteCny || !finiteSgd) {
    const available = currency === 'CNY' && finiteCny ? money(Number(cny),'CNY') : currency === 'SGD' && finiteSgd ? money(Number(sgd),'SGD') : '—';
    return `<span class="money-static ${className}">${available}</span>`;
  }
  const value = currency === 'CNY' ? Number(cny) : Number(sgd);
  const unit = currency === 'CNY' ? 'CNY' : 'SGD';
  return `<button type="button" class="money-toggle ${className}" data-cny="${Number(cny)}" data-sgd="${Number(sgd)}" data-currency="${currency}" title="点击切换人民币 / 新币">${money(value,unit)}<span aria-hidden="true">↔</span></button>`;
}
function amountFromCny(cny, currency='CNY', className='') {
  const value = Number(cny);
  return amountToggle(value, Number.isFinite(cnyToSgd) ? value*cnyToSgd : NaN, currency, className);
}
function amountFromSgd(sgd, currency='SGD', className='') {
  const value = Number(sgd);
  return amountToggle(Number.isFinite(cnyToSgd) && cnyToSgd ? value/cnyToSgd : NaN, value, currency, className);
}
function amountRangeFromSgd(low, high, currency='SGD', className='') {
  const lowValue = Number(low), highValue = Number(high);
  if (!Number.isFinite(lowValue) || !Number.isFinite(highValue)) return `<span class="money-static ${className}">—</span>`;
  if (!Number.isFinite(cnyToSgd) || !cnyToSgd) return `<span class="money-static ${className}">${money(lowValue,'SGD')} – ${money(highValue,'SGD')}</span>`;
  const lowCny = lowValue/cnyToSgd, highCny = highValue/cnyToSgd;
  const left = currency === 'CNY' ? money(lowCny,'CNY') : money(lowValue,'SGD');
  const right = currency === 'CNY' ? money(highCny,'CNY') : money(highValue,'SGD');
  return `<button type="button" class="money-toggle money-range-toggle ${className}" data-low-cny="${lowCny}" data-high-cny="${highCny}" data-low-sgd="${lowValue}" data-high-sgd="${highValue}" data-currency="${currency}" title="点击切换人民币 / 新币">${left} – ${right}<span aria-hidden="true">↔</span></button>`;
}
function updateAmountToggle(button) {
  const currency = button.dataset.currency === 'CNY' ? 'SGD' : 'CNY';
  button.dataset.currency = currency;
  if (button.classList.contains('money-range-toggle')) {
    const cny = currency === 'CNY';
    button.innerHTML = `${money(Number(button.dataset[cny?'lowCny':'lowSgd']),cny?'CNY':'SGD')} – ${money(Number(button.dataset[cny?'highCny':'highSgd']),cny?'CNY':'SGD')}<span aria-hidden="true">↔</span>`;
  } else {
    button.innerHTML = `${money(Number(button.dataset[currency.toLowerCase()]),currency)}<span aria-hidden="true">↔</span>`;
  }
}
function safeUrl(value) {
  if (typeof value === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value.trim())) return value.trim();
  try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
}
function calc(item) {
  const fx = cnyToSgd;
  const purchaseSgd = fx ? (Number(item.priceCny)||0) * fx : NaN;
  const xianyuShippingCny = isXianyu(item.platform) ? 150 : 0;
  const shippingCny = fx ? xianyuShippingCny * fx : NaN;
  const inspectionCny = fx ? (isXianyu(item.platform) ? 54 : 0) * fx : NaN;
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
function sellerNameOnly(value) {
  const leading = String(value || '').split(/[·|｜]/, 1)[0].trim();
  return leading.replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim();
}
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
  item.createdAt = timestamp(item.createdAt || item.created_at, Date.now());
  item.firstSeenAt = timestamp(item.firstSeenAt || item.first_seen_at || item.discoveredAt || item.discovered_at || item.createdAt, item.createdAt);
  return item;
}
function preserveAnalysis(incoming, existing, cloudAnalysis) {
  const useCloud = !!cloudAnalysis && timestamp(cloudAnalysis.updatedAt,0) >= timestamp(existing?.analysisUpdatedAt,0);
  const source = useCloud ? cloudAnalysis : existing;
  if (!source) return incoming;
  for (const field of ANALYSIS_FIELDS) if (source[field] !== undefined && source[field] !== '') incoming[field] = source[field];
  if (existing) {
    incoming.createdAt = existing.createdAt || incoming.createdAt;
    incoming.firstSeenAt = timestamp(existing.firstSeenAt || existing.createdAt || incoming.firstSeenAt, incoming.firstSeenAt);
  }
  const updatedAt = useCloud ? timestamp(cloudAnalysis.updatedAt,0) : timestamp(existing?.analysisUpdatedAt,0);
  if (updatedAt) incoming.analysisUpdatedAt = updatedAt;
  return incoming;
}
function updateSyncText(text) {
  syncStatus = text;
  const element = document.querySelector('#syncText');
  if (element) element.textContent = text;
}
function openImageViewer(images, index=0, description='商品原图') {
  viewerImages = images;
  if (!viewerImages.length) return;
  viewerIndex = Math.max(0, Math.min(index, viewerImages.length - 1));
  viewerDescription = description || '商品原图';
  imageViewerStage.classList.remove('actual-size');
  fullSizeImage.classList.remove('actual-size');
  showViewerImage();
  imageDialog.showModal();
}
function showViewerImage() {
  imageViewerStage.classList.remove('actual-size');
  fullSizeImage.classList.remove('actual-size');
  fullSizeImage.src = viewerImages[viewerIndex];
  fullSizeImage.alt = `${viewerDescription} · 图片 ${viewerIndex + 1}`;
  imageDimensions.textContent = '正在读取图片尺寸…';
  imageCounter.textContent = `${viewerIndex + 1} / ${viewerImages.length}`;
  imageCounter.hidden = viewerImages.length < 2;
  previousViewerImage.hidden = viewerImages.length < 2;
  nextViewerImage.hidden = viewerImages.length < 2;
  imageSizeToggle.textContent = '查看原尺寸（100%）';
  imageDialog.scrollTop = 0;
}
function stepViewerImage(amount) {
  if (viewerImages.length < 2) return;
  viewerIndex = (viewerIndex + amount + viewerImages.length) % viewerImages.length;
  showViewerImage();
}
function toggleImageSize() {
  const actualSize = imageViewerStage.classList.toggle('actual-size');
  fullSizeImage.classList.toggle('actual-size', actualSize);
  imageSizeToggle.textContent = actualSize ? '适应窗口' : '查看原尺寸（100%）';
}
async function syncListings() {
  if (githubTokenLoading) await loadGithubToken();
  updateSyncText('正在同步巡查数据…');
  try {
    const cacheKey = Date.now();
    const [response,deletedResponse,cloudResponse] = await Promise.all([
      fetch(`${LISTINGS_URL}?_=${cacheKey}`, {cache:'no-store'}),
      fetch(`${DELETED_LISTINGS_URL}?_=${cacheKey}`, {cache:'no-store'}),
      fetch(`${CLOUD_DATA_URL}?_=${cacheKey}`, {cache:'no-store'}).catch(()=>null),
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const rows = remoteRows(payload);
    if (!deletedResponse.ok && deletedResponse.status !== 404) throw new Error(`删除记录 HTTP ${deletedResponse.status}`);
    const deletedPayload = deletedResponse.ok ? await deletedResponse.json() : [];
    const allDeletedIds = deletedIdsFromPayload(deletedPayload);
    if (cloudResponse?.ok) saveCloudUserDataCache(await cloudResponse.json());
    else if (cloudResponse && cloudResponse.status!==404) console.warn(`云端个人数据暂不可用：HTTP ${cloudResponse.status}；继续使用本机缓存`);
    const currentByKey = new Map(listings.map(item => [listingKey(item), item]));
    const userDeletedIds = loadUserDeletedIds();
    for (const id of cloudUserData.userDeletedIds) userDeletedIds.add(id);
    for (const id of allDeletedIds) userDeletedIds.add(id);
    saveUserDeletedIds(userDeletedIds);
    const synced = [];
    for (const raw of rows.filter(item => item && typeof item === 'object')) {
      const normalized = normalizeFeedItem(raw);
      const id = listingKey(normalized);
      const item = preserveAnalysis(normalized, currentByKey.get(id),cloudUserData.analysisById[id]);
      if (allDeletedIds.has(id) || userDeletedIds.has(id)) continue;
      synced.push(item);
    }
    const manual = mergeCloudManualListings(cloudUserData.manualListings,listings.filter(item => !item.syncManaged),userDeletedIds);
    listings = [...manual, ...synced];
    saveListings();
    const cloudManualById=new Map(cloudUserData.manualListings.map(item=>[listingKey(item),item]));
    const needsMigration=[
      ...manual.filter(item=>{
        const cloudItem=cloudManualById.get(listingKey(item));
        return !cloudItem || timestamp(item.cloudUpdatedAt,0)>timestamp(cloudItem.cloudUpdatedAt,0);
      }),
      ...synced.filter(item=>{
        const cloudAnalysis=cloudUserData.analysisById[listingKey(item)];
        const hasAnalysis=ANALYSIS_FIELDS.some(field=>item[field]!==undefined&&item[field]!=='');
        return hasAnalysis && (!cloudAnalysis || timestamp(item.analysisUpdatedAt,0)>timestamp(cloudAnalysis.updatedAt,0));
      }),
    ];
    const time = new Intl.DateTimeFormat('zh-SG', {hour:'2-digit',minute:'2-digit'}).format(new Date());
    updateSyncText(`已同步 ${synced.length} 条巡查商品 · ${time}`);
    render();
    if(githubToken&&(needsMigration.length||[...userDeletedIds].some(id=>!cloudUserData.userDeletedIds.includes(id)))) await pushCloudChanges(needsMigration);
    return true;
  } catch (error) {
    console.error('巡查数据同步失败', error);
    updateSyncText(`巡查数据同步失败 · ${String(error?.message||'网络错误').slice(0,56)}`);
    return false;
  }
}
function spec(label, value) { return `<div><div class="spec-label">${label}</div><div class="spec-value">${esc(value || '—')}</div></div>`; }
function itemImages(item) {
  return (Array.isArray(item.images) ? item.images : [item.image])
    .map(image => safeUrl(typeof image === 'string' ? image : (image?.url || image?.src || '')))
    .filter(Boolean).slice(0, 10);
}
function recommendation(item, c) {
  if (!Number.isFinite(c.profitLow) || !Number.isFinite(c.profitHigh)) return 0;
  const referenceProfit = (c.profitLow + c.profitHigh) / 2;
  const margin = referenceProfit / Math.max(1, c.baseCost);
  const profitScore = Math.max(0, Math.min(1, (margin + 0.05) / 0.35));
  const samples = Math.max(1, Math.min(5, Number(item.sampleCount) || 1));
  const confidence = 0.72 + samples * 0.056;
  return c.decision === 'red' ? 0 : Math.round(profitScore * confidence * 100);
}
function platformStyle(item) {
  return item.platform === 'Carousell' ? 'carousell' : item.platform === '闲鱼' ? 'xianyu' : 'other';
}
function listingPriceLabel(item,c) {
  return item.platform === 'Carousell' ? amountFromSgd(c.purchaseSgd,'SGD') : amountFromCny(Number(item.priceCny||0),'CNY');
}
function suggestedBuyLabel(item,c) {
  const askCny = Number(item.priceCny)||0;
  const capped = Number.isFinite(c.maxBuyCny) && askCny > 0 ? Math.min(c.maxBuyCny, askCny) : c.maxBuyCny;
  return amountFromCny(capped,item.platform === 'Carousell' ? 'SGD' : 'CNY');
}
function soldReference(item,c) {
  if (!(c.low > 0 || c.high > 0)) return '';
  const average = (c.low+c.high)/2;
  return `<div class="sold-reference"><small>成交参考</small><span>${amountRangeFromSgd(c.low,c.high,'SGD')} <i>均价</i> ${amountFromSgd(average,'SGD')}</span></div>`;
}
function recommendationTone(score, decision) {
  if (decision === 'red') return 'rec-avoid';
  if (score >= 40) return 'rec-best';
  if (score >= 20) return 'rec-good';
  if (score >= 8) return 'rec-watch';
  return 'rec-low';
}
function renderCard(item) {
  const c = calc(item);
  const labels = {green:'可以买',yellow:'谨慎评估',red:'建议不买'};
  const decision = rateStatus === 'error' ? 'yellow' : c.decision;
  const score = recommendation(item, c);
  const recTone = recommendationTone(score, decision);
  const listing = safeUrl(item.url);
  const platformLabel = item.platform || '未注明平台';
  const platformClass = platformStyle(item);
  const images = itemImages(item);
  const galleryIndex = images.length ? ((galleryIndexes.get(item.id) || 0) % images.length) : 0;
  const image = images[galleryIndex];
  const totalFeeLow = Number.isFinite(c.baseCost) ? c.baseCost + c.low*c.rate : NaN;
  const totalFeeHigh = Number.isFinite(c.baseCost) ? c.baseCost + c.high*c.rate : NaN;
  return `<article class="listing-card feed-card" data-id="${esc(item.id)}">
    ${image ? `<button type="button" class="feed-image" data-detail-open data-id="${esc(item.id)}" aria-label="查看商品详情：${esc(item.description || 'MacBook 商品图片')}"><img src="${esc(image)}" alt="${esc(item.description || 'MacBook 商品图片')}" loading="lazy" onerror="this.closest('.feed-image').classList.add('image-error')">${images.length>1?`<span class="feed-image-count">${images.length} 张照片</span>`:''}</button>` : `<button type="button" class="feed-image feed-image-empty" data-detail-open data-id="${esc(item.id)}">查看商品详情</button>`}
    <div class="feed-card-content">
      <button type="button" class="feed-title" data-detail-open data-id="${esc(item.id)}"><span class="platform-badge ${platformClass}">${esc(platformLabel)}</span><span>${esc(item.description || '未命名商品')}</span></button>
      <div class="feed-price-row"><div class="feed-price asking"><small>挂价</small><strong>${listingPriceLabel(item,c)}</strong>${soldReference(item,c)}</div><div class="feed-price target"><small>建议购入</small><strong>${suggestedBuyLabel(item,c)}</strong></div><div class="recommend-score ${recTone}"><small>推荐指数</small><strong>${score}<small>%</small></strong></div></div>
      <div class="feed-profit"><span>预计利润</span><strong class="${c.profitLow>=0?'pos':'neg'}">${amountRangeFromSgd(c.profitLow,c.profitHigh,'SGD')}</strong></div>
    </div>
  </article>`;
}
function renderDetail(item) {
  const c = calc(item);
  const labels = {green:'可以买',yellow:'谨慎评估',red:'建议不买'};
  const decision = rateStatus === 'error' ? 'yellow' : c.decision;
  const sold = safeUrl(item.soldSource);
  const listing = safeUrl(item.url);
  const platformClass = platformStyle(item);
  const platformLabel = item.platform || '未注明平台';
  const images = itemImages(item);
  const galleryIndex = images.length ? ((galleryIndexes.get(item.id) || 0) % images.length) : 0;
  const image = images[galleryIndex];
  const score = recommendation(item, c);
  const recTone = recommendationTone(score, decision);
  const totalFeeLow = Number.isFinite(c.baseCost) ? c.baseCost + c.low*c.rate : NaN;
  const totalFeeHigh = Number.isFinite(c.baseCost) ? c.baseCost + c.high*c.rate : NaN;
  return `<div class="detail-page-nav"><button type="button" class="back-button" id="backToFeed">‹ <span>返回巡查列表</span></button><span>商品详情</span></div>
  <article class="listing-card detail-card" data-id="${esc(item.id)}">
    ${image ? `<div class="card-cover detail-cover"><button type="button" class="card-image-button" data-image-open data-image-src="${esc(image)}" data-image-alt="${esc(`${item.description || 'MacBook 商品图片'} · 图片 ${galleryIndex + 1}`)}" aria-label="查看原图：${esc(item.description || 'MacBook 商品图片')}"><img src="${esc(image)}" alt="${esc(item.description || 'MacBook 商品图片')} · 图片 ${galleryIndex + 1}" loading="lazy" onerror="this.closest('.card-cover').classList.add('image-error');this.closest('.card-image-button').remove()"></button><span class="image-open-hint" aria-hidden="true">查看原图 ↗</span>${images.length > 1 ? `<div class="gallery-controls detail-gallery-controls"><span class="gallery-count">${galleryIndex + 1} / ${images.length}</span><div class="gallery-arrows"><button type="button" class="gallery-button" data-gallery-step="-1" data-id="${esc(item.id)}" aria-label="上一张图片">‹</button><button type="button" class="gallery-button" data-gallery-step="1" data-id="${esc(item.id)}" aria-label="下一张图片">›</button></div></div>` : ''}</div>` : ''}
    <div class="card-content detail-card-content">
      <div class="card-heading detail-heading"><div class="feed-title-static"><span class="platform-badge ${platformClass}">${esc(platformLabel)}</span><h2>${esc(item.description || '未命名商品')}</h2></div><span class="decision ${decision}">${labels[decision]}</span></div>
      <div class="price-comparison"><div><small>商品挂价</small><strong class="asking-price">${listingPriceLabel(item,c)}</strong>${soldReference(item,c)}</div><div><small>建议购入价</small><strong>${suggestedBuyLabel(item,c)}</strong>${Number.isFinite(c.maxBuyCny) && Number(item.priceCny) > 0 && c.maxBuyCny > Number(item.priceCny) ? '<small>挂价已低于可接受上限，按挂价买即可</small>' : ''}</div><div class="comparison-profit"><small>预计利润区间</small><strong class="${c.profitLow>=0?'pos':'neg'}">${amountRangeFromSgd(c.profitLow,c.profitHigh,'SGD')}</strong></div></div>
      <p class="recommend-line"><span class="recommend-score ${recTone}"><small>推荐指数</small><strong>${score}<small>%</small></strong></span><span>按已成交样本估算 · ${esc(item.sampleCount || 1)} 个样本</span></p>
      <p class="seller-line">卖家：<button type="button" class="seller-copy" data-copy-seller="${esc(sellerNameOnly(item.sellerName || item.nickname || item.username || item.seller || ''))}" title="点击复制卖家名字">${esc(item.seller || '未填写')}<span aria-hidden="true">复制</span></button></p>
      ${listing?`<a class="product-link" href="${esc(listing)}" target="_blank" rel="noopener"><span class="product-link-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M13.5 6H18v4.5M18 6l-8 8"/><path d="M17 13v5H6V7h5"/></svg></span><span class="product-link-copy"><strong>打开商品页面</strong><small>${esc(new URL(listing).hostname)}</small></span><span class="product-link-arrow" aria-hidden="true">↗</span></a>`:''}
      <section class="detail-section"><h3 class="section-title">机器信息</h3><div class="spec-grid">${spec('平台',item.platform)}${spec('尺寸',item.size)}${spec('芯片',item.chip)}${spec('内存',item.memory)}${spec('硬盘',item.storage)}${spec('电池健康',item.battery)}${spec('循环次数',item.cycles ? `${item.cycles} 次` : '')}${spec('成色',item.condition)}${spec('保修',item.warranty)}</div></section>
      <section class="detail-section"><h3 class="section-title">费用明细 <small>点击金额切换 CNY / SGD</small></h3><div class="cost-list">
        <div class="cost-row"><span>商品价格</span><span>${amountFromCny(Number(item.priceCny||0),'SGD')}</span></div>
        ${isXianyu(item.platform) ? `<div class="cost-row"><span>闲鱼运费</span><span>${amountFromSgd(c.shippingCny,'SGD')}</span></div>
        <div class="cost-row"><span>验货宝</span><span>${amountFromSgd(c.inspectionCny,'SGD')}</span></div>` : `<div class="cost-row"><span>本地自提（无闲鱼运费、无验货宝）</span><span>$0</span></div>`}
        <div class="cost-row"><span>跨境运输</span><span>${amountFromSgd(c.shippingSgd,'SGD')}</span></div>
        <div class="cost-row"><span>维修 / 整备</span><span>${amountFromSgd(c.repairSgd,'SGD')}</span></div>
        <div class="cost-row"><span>平台费 · ${(Number(item.feePercent)||0).toFixed(1)}%（随成交价变化）</span><span>${amountRangeFromSgd(c.low*c.rate,c.high*c.rate,'SGD')}</span></div>
        <div class="cost-row total"><span>预计总成本（含平台费）</span><span>${amountRangeFromSgd(totalFeeLow,totalFeeHigh,'SGD')}</span></div>
      </div><p class="price-source"><b>成交参考：</b>${sold?`<a class="sold-source" href="${esc(sold)}" target="_blank" rel="noopener">${esc(item.soldSource)} ↗</a>`:esc(item.soldSource || '请填写已成交记录来源')}<br>请使用近期同配置真实成交记录；工具按录入区间估算，不抓取平台在售标价。</p></section>
      <div class="card-footer"><div class="max-buy"><small>最高建议买价 · 含目标利润 ${amountFromSgd(Number(item.targetProfit)||0,'SGD')}</small><strong>${amountFromCny(c.maxBuyCny,/carousell/i.test(item.platform || '') ? 'SGD' : 'CNY')}</strong></div><div class="card-actions"><button class="quiet-button edit-button" data-id="${esc(item.id)}">编辑</button><button class="quiet-button delete delete-button" data-id="${esc(item.id)}">删除</button></div></div>
    </div>
  </article>`;
}
function render() {
  const sort = document.querySelector('#sortMode').value;
  const filter = document.querySelector('#platformFilter').value;
  const filtered = listings.filter(item => filter==='all' || (filter==='xianyu' ? isXianyu(item.platform) : /carousell/i.test(item.platform||'')));
  const sorted = [...filtered].sort((a,b) => {
    if (sort === 'date') return b.createdAt-a.createdAt;
    if (sort === 'recommend') return recommendation(b,calc(b))-recommendation(a,calc(a));
    if (sort === 'ask') return (Number(a.priceCny)||0)-(Number(b.priceCny)||0);
    return calc(b).profitLow-calc(a).profitLow;
  });
  const selected = listings.find(item => item.id === selectedListingId);
  grid.hidden = !!selected;
  document.querySelector('#detailView').hidden = !selected;
  document.querySelector('#detailView').innerHTML = selected ? renderDetail(selected) : '';
  grid.innerHTML = selected ? '' : sorted.map(renderCard).join('');
  document.querySelector('#listingCount').textContent = `${filtered.length} 台商品`;
  const emptyState=document.querySelector('#emptyState');
  emptyState.classList.toggle('visible', filtered.length===0 && !selected);
  if(filtered.length===0 && listings.length>0){emptyState.querySelector('h2').textContent='这个平台暂无巡查商品';}
  else if(!selected){emptyState.querySelector('h2').textContent='暂时没有巡查商品';}
}
function updateRateText() {
  const el = document.querySelector('#rateText');
  if (rateStatus==='loading') el.textContent='正在获取汇率…';
  else if (rateStatus==='error') el.textContent='汇率获取失败 · 点此重试';
  else if (rateStatus==='cached') el.textContent=`1 CNY = ${cnyToSgd.toFixed(4)} SGD · 缓存 ${rateDate}`;
  else el.textContent=`1 CNY = ${cnyToSgd.toFixed(4)} SGD · ${rateDate}`;
}
async function fetchRate() {
  rateStatus='loading'; updateRateText();
  try {
    let data;
    if (window.macbookFlip?.fetchExchangeRate) data = await window.macbookFlip.fetchExchangeRate();
    else {
      const response = await fetch(RATE_URL, {cache:'no-store'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data = await response.json();
    }
    if (!data.rates?.SGD || !data.date) throw new Error('汇率数据格式不正确');
    cnyToSgd=data.rates.SGD; rateDate=data.date; rateStatus='ok';
    try { localStorage.setItem(RATE_CACHE_KEY,JSON.stringify({rate:cnyToSgd,date:rateDate})); } catch {}
  } catch (error) {
    rateStatus=cnyToSgd&&rateDate?'cached':'error';
    console.error('汇率加载失败',error);
  }
  updateRateText(); render();
}
function openDetail(id) {
  if (!selectedListingId) {
    feedScrollY = window.scrollY;
    history.pushState({macbookFlipDetail:id,feedScrollY},'',`${location.pathname}${location.search}#item=${encodeURIComponent(id)}`);
  }
  selectedListingId = id;
  render();
  window.scrollTo({top:0,behavior:'smooth'});
}
function restoreFeed() {
  selectedListingId = null;
  render();
  requestAnimationFrame(()=>window.scrollTo({top:feedScrollY,behavior:'instant'}));
}
function returnToFeed() {
  if (!selectedListingId) return;
  if (history.state?.macbookFlipDetail) history.back();
  else restoreFeed();
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
document.querySelector('#closeDialog').addEventListener('click',()=>dialog.close());
document.querySelector('#cancelDialog').addEventListener('click',()=>dialog.close());
document.querySelector('#sortMode').value=currentSortMode;
document.querySelector('#platformFilter').value=currentPlatformFilter;
document.querySelector('#sortMode').addEventListener('change',event=>{
  currentSortMode=VALID_SORT_MODES.has(event.target.value)?event.target.value:'profit';
  localStorage.setItem(SORT_MODE_KEY,currentSortMode);
  render();window.scrollTo({top:0,behavior:'smooth'});
});
document.querySelector('#platformFilter').addEventListener('change',event=>{
  currentPlatformFilter=VALID_PLATFORMS.has(event.target.value)?event.target.value:'all';
  localStorage.setItem(PLATFORM_FILTER_KEY,currentPlatformFilter);
  render();window.scrollTo({top:0,behavior:'smooth'});
});
const backupDialog = document.querySelector('#backupDialog');
document.querySelector('#backupData').addEventListener('click',()=>backupDialog.showModal());
document.querySelector('#closeBackupDialog').addEventListener('click',()=>backupDialog.close());
document.querySelector('#exportBackup').addEventListener('click',async()=>{
  try { await exportDataBackup(); backupDialog.close(); }
  catch(error) { console.error('导出备份失败',error); toast(error.message || '导出备份失败'); }
});
const backupFileInput = document.querySelector('#backupFileInput');
document.querySelector('#importBackup').addEventListener('click',()=>backupFileInput.click());
backupFileInput.addEventListener('change',async()=>{
  const file=backupFileInput.files?.[0];
  backupFileInput.value='';
  if(!file)return;
  try {
    const backup=JSON.parse(await file.text());
    importDataBackup(backup);
    backupDialog.close();
    void pushCloudChanges(listings);
    toast('已导入备份并合并到当前巡查列表');
  } catch(error) { console.error('导入备份失败',error); toast(error.message || '备份文件读取失败'); }
});
document.querySelector('#refreshRate').addEventListener('click',fetchRate);
const githubTokenDialog = document.querySelector('#githubTokenDialog');
document.querySelector('#githubAuthButton').addEventListener('click',openGithubAuthDialog);
document.querySelector('#closeGithubTokenDialog').addEventListener('click',()=>githubTokenDialog.close());
document.querySelector('#cancelGithubToken').addEventListener('click',()=>githubTokenDialog.close());
document.querySelector('#disconnectGithub').addEventListener('click',async()=>{
  await clearGithubToken();
  pendingDeleteId=null;
  githubTokenDialog.close();
  toast('已断开 GitHub 连接');
});
document.querySelector('#githubTokenForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=document.querySelector('#saveGithubToken');
  const token=document.querySelector('#githubTokenInput').value.trim();
  if(!token){toast('请先粘贴 GitHub 令牌');return;}
  button.disabled=true;
  button.textContent='正在验证…';
  try{
    await connectGithubToken(token);
    await syncListings();
    githubTokenDialog.close();
    toast('GitHub 仓库已连接');
    if(pendingDeleteId)await performRemoteDelete(pendingDeleteId);
  }catch(error){toast(error.message);}
  finally{button.disabled=false;button.textContent='连接';}
});
githubTokenDialog.addEventListener('close',()=>{
  if(!githubToken)pendingDeleteId=null;
  document.querySelector('#githubTokenInput').value='';
});
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
document.querySelector('.page-shell').addEventListener('click',async event=>{
  const moneyButton=event.target.closest('.money-toggle');
  if(moneyButton){event.preventDefault();updateAmountToggle(moneyButton);return;}
  const sellerCopy=event.target.closest('[data-copy-seller]');
  if(sellerCopy){
    const name=sellerCopy.dataset.copySeller;
    if(name){
      try{await navigator.clipboard.writeText(name);toast('已复制卖家名字');}
      catch{toast('复制失败，请长按卖家名字复制');}
    }
    return;
  }
  const detailOpen=event.target.closest('[data-detail-open]');
  if(detailOpen){openDetail(detailOpen.dataset.id);return;}
  if(event.target.closest('#backToFeed')){returnToFeed();return;}
  const imageOpen=event.target.closest('[data-image-open]');
  if(imageOpen){
    const card=imageOpen.closest('.listing-card');
    const item=listings.find(x=>x.id===card?.dataset.id);
    const images=(Array.isArray(item?.images)?item.images:(item?.image?[item.image]:[]))
      .map(image=>safeUrl(typeof image==='string'?image:(image?.url||image?.src||'')))
      .filter(Boolean).slice(0,10);
    const currentImage=images.length?(galleryIndexes.get(item?.id)||0)%images.length:0;
    openImageViewer(images.length?images:[imageOpen.dataset.imageSrc].filter(Boolean),currentImage,item?.description||imageOpen.dataset.imageAlt);
    return;
  }
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
  if(remove){
    const item=listings.find(x=>x.id===remove.dataset.id);
    if(!item||!window.confirm(`确定删除这条商品吗？\n\n“${item.description||'未命名商品'}”会从 GitHub 巡查列表移除，并在其他设备下次同步时删除。`))return;
    if(githubTokenLoading)await loadGithubToken();
    pendingDeleteId=item.id;
    if(!githubToken){openGithubAuthDialog();return;}
    await performRemoteDelete(item.id);
  }
});
window.addEventListener('popstate',()=>{if(selectedListingId)restoreFeed();});
let detailSwipeStart=null;
document.querySelector('#detailView').addEventListener('touchstart',event=>{
  if(!selectedListingId||event.touches.length!==1||event.target.closest('.detail-cover,button,a,input,select')){detailSwipeStart=null;return;}
  const touch=event.touches[0];detailSwipeStart={x:touch.clientX,y:touch.clientY};
},{passive:true});
document.querySelector('#detailView').addEventListener('touchend',event=>{
  if(!detailSwipeStart||!event.changedTouches.length){detailSwipeStart=null;return;}
  const touch=event.changedTouches[0],dx=touch.clientX-detailSwipeStart.x,dy=touch.clientY-detailSwipeStart.y;
  detailSwipeStart=null;
  if(Math.abs(dx)>90&&Math.abs(dx)>Math.abs(dy)*1.35)returnToFeed();
},{passive:true});
imageSizeToggle.addEventListener('click',toggleImageSize);
fullSizeImage.addEventListener('click',toggleImageSize);
fullSizeImage.addEventListener('load',()=>{imageDimensions.textContent=`${fullSizeImage.naturalWidth} × ${fullSizeImage.naturalHeight} px`;});
previousViewerImage.addEventListener('click',()=>stepViewerImage(-1));
nextViewerImage.addEventListener('click',()=>stepViewerImage(1));
imageDialog.addEventListener('keydown',event=>{
  if(event.key==='ArrowLeft'){event.preventDefault();stepViewerImage(-1);}
  if(event.key==='ArrowRight'){event.preventDefault();stepViewerImage(1);}
});
document.querySelector('#closeImageViewer').addEventListener('click',()=>imageDialog.close());
imageDialog.addEventListener('click',event=>{if(event.target===imageDialog)imageDialog.close();});
imageDialog.addEventListener('close',()=>{fullSizeImage.removeAttribute('src');viewerImages=[];});
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
  const now=Date.now();
  data.id=data.id||crypto.randomUUID(); data.createdAt=index>=0?listings[index].createdAt:now; data.firstSeenAt=index>=0?(listings[index].firstSeenAt||listings[index].createdAt||now):now; data.syncManaged=index>=0?!!listings[index].syncManaged:false;
  if(data.syncManaged)data.analysisUpdatedAt=now;else data.cloudUpdatedAt=now;
  if(index>=0)listings[index]=data;else listings.push(data);
  saveListings();render();dialog.close();void pushCloudChanges([data]);
});
function toast(message){const el=document.createElement('div');el.className='toast';el.textContent=message;document.body.append(el);setTimeout(()=>el.remove(),2200);}
render(); loadGithubToken(); fetchRate();
void restoreListingsFromIndexedDB().finally(()=>syncListings());
setInterval(syncListings, SYNC_INTERVAL_MS);
