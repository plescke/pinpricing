// fetchWithProxy.mjs
import { fetch, ProxyAgent } from "undici";
import { promises as fs } from "fs";
import path from "path";

// --- konfiguracja ---
const API_URL =
  process.env.API_URL ||
  "https://api.youpin898.com/api/homepage/pc/goods/market/querySaleTemplate";
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);
const DELAY_MS = Number(process.env.PAGE_DELAY_MS || 20000);
const MAX_PAGES = process.env.MAX_PAGES
  ? Number(process.env.MAX_PAGES)
  : undefined;

// proxy (jeśli nie masz proxy, ustaw na null)
const proxyUrl =
  process.env.PROXY_URL ||
  "http://jakub_pool-custom_type-low:Asus32566@proxy.suborbit.al:1337";
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

// --- nagłówki domyślne ---
const defaultHeaders = {
  accept: "application/json, text/plain, */*",
  "accept-language": "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",
  "app-version": "5.26.0",
  apptype: "1",
  appversion: "5.26.0",
  authorization: "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJqdGkiOiI4ZDNjOGI2Yjc2NGE0Mzc0YTJjMjA1N2E5YzZmNzI4YiIsIm5hbWVpZCI6IjEyNzA2NDUzIiwiSWQiOiIxMjcwNjQ1MyIsInVuaXF1ZV9uYW1lIjoiWVAwMDEyNzA2NDUzIiwiTmFtZSI6IllQMDAxMjcwNjQ1MyIsInZlcnNpb24iOiJYT3MiLCJuYmYiOjE3NTcyNDU3NDAsImV4cCI6MTc1NzI0NzU0MCwiaXNzIjoieW91cGluODk4LmNvbSIsImRldmljZUlkIjoiOWZjMTNlM2UtZTc3Yi00MzlmLTkzZTgtMDVhZjM3ZDEwNmFkIiwiYXVkIjoidXNlciJ9.OAGk0-HRDBK9jpvpu4lM5Ph483I_IhWh6np268ggqqU",
  b3: "9af52d177e4343b5abc91e1ca3b49ccd-95753cbe4021713c-1",
  "content-type": "application/json",
  deviceid: "176a2f54-968c-43af-821b-e54e158509a0",
  deviceuk:
    "5FPuLiZgBi7SdIAwHKPaAP2kEIcYFVo2VMtLkXRB7VHQ7CPgYZw0liFAGgRW4Nh1G",
  platform: "pc",
  priority: "u=1, i",
  "sec-ch-ua":
    '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
  "secret-v": "h5_v1",
  traceparent: "00-9af52d177e4343b5abc91e1ca3b49ccd-95753cbe4021713c-01",
  tracestate:
    "rum=v2&browser&hwztx6svg3@74450dd02fdbfcd&2418ab383ddf47f58c90bb3c905b21d0&uid_lkx8rcnnlcypd3cx",
  uk: "5FOEiwjOqya7iRr1U35jw6LDlJ7k6U2n9KDto4LPEoyqMYmrCepCKtnRW2HobKH1K",
  Referer: "https://youpin898.com/"
};

let headers = { ...defaultHeaders };
if (process.env.HEADERS_JSON) {
  try {
    const parsed = JSON.parse(process.env.HEADERS_JSON);
    headers = { ...headers, ...parsed };
  } catch (e) {
    console.error("Nie udało się sparsować HEADERS_JSON:", e.message);
  }
}

// --- fetch z proxy (jedna próba) ---
async function fetchPage(pageIndex) {
  const body = {
    listSortType: 7,
    sortType: 2,
    minPrice: 70,
    maxPrice: 9999999.99,
    pageSize: PAGE_SIZE,
    pageIndex
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    dispatcher
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`HTTP ${res.status} ${res.statusText} - ${text}`);
  }
  return await res.json();
}

// --- retry wrapper ---
async function fetchPageWithRetry(pageIndex, retries = 3, delayMs = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetchPage(pageIndex);
    } catch (err) {
      console.error(
        `Błąd przy pobieraniu strony ${pageIndex} (próba ${attempt}/${retries}): ${err.message}`
      );
      if (attempt < retries) {
        console.log(`Czekam ${delayMs}ms i ponawiam...`);
        await sleep(delayMs);
      } else {
        throw err;
      }
    }
  }
}

// --- przetwarzanie danych ---
function processPageData(data, oldCache = []) {
  if (!data || !data.Data) return [];

  return data.Data.filter((item) => item.onSaleCount >= 12).map((item) => {
    const itemName = item.commodityHashName;
    const price = Number(item.price);
    const count = Number(item.onSaleCount);

    if (!Number.isFinite(price) || price <= 0) return null;

    const oldItem = oldCache.find((c) => c.item === itemName);
    if (oldItem) {
      if (price >= Number(oldItem.price) * 1.015) {
        return { item: itemName, price, onSaleCount: count };
      } else {
        return { ...oldItem, onSaleCount: count }; // aktualizacja ilości
      }
    } else {
      return { item: itemName, price, onSaleCount: count };
    }
  }).filter(Boolean);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- helper do zapisu na bieżąco ---
async function saveCache(cachePath, cache) {
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
}

// --- główna logika ---
async function scanAll() {
  console.log("Rozpoczynam nowe skanowanie...");
  const publicDir = path.join(process.cwd(), "public");
  await fs.mkdir(publicDir, { recursive: true });

  const cachePath = path.join(publicDir, "prices.json");
  let cache = [];
  try {
    const raw = await fs.readFile(cachePath, "utf-8");
    cache = JSON.parse(raw);
  } catch {
    cache = [];
  }

  const first = await fetchPageWithRetry(1);
  const totalCount = first?.TotalCount ?? 0;
  const pages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pagesToFetch = MAX_PAGES ? Math.min(pages, MAX_PAGES) : pages;

  console.log(
    `Łączna liczba: ${totalCount}, stron: ${pages} -> pobiorę: ${pagesToFetch}`
  );

  const newCacheMap = new Map();

  for (let p = 1; p <= pagesToFetch; p++) {
    if (p > 1) {
      await sleep(DELAY_MS);
    }
    console.log(`Pobieram stronę ${p}...`);
    const pageData = await fetchPageWithRetry(p);
    const processed = processPageData(pageData, cache);

    processed.forEach((it) => newCacheMap.set(it.item, it));
    cache = Array.from(newCacheMap.values());

    // >>> zapisujemy na bieżąco <<<
    await saveCache(cachePath, cache);

    console.log(
      `Przetworzono stronę ${p}, items: ${processed.length}, zapisano prices.json`
    );
  }


  console.log("Skanowanie zakończone.");
}

(async () => {
  try {
    await scanAll();
    console.log("Gotowe.");
    process.exit(0);
  } catch (e) {
    console.error("Błąd główny:", e);
    process.exit(1);
  }
})();
