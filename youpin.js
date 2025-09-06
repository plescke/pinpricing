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
  authorization:
    "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJqdGkiOiJhMjVmOWZkNjhlMjk0NDc5YWI1MjRhYmU4ZDFiOTk4MSIsIm5hbWVpZCI6IjEyNzA2NDUzIiwiSWQiOiIxMjcwNjQ1MyIsInVuaXF1ZV9uYW1lIjoiWVAwMDEyNzA2NDUzIiwiTmFtZSI6IllQMDAxMjcwNjQ1MyIsInZlcnNpb24iOiI1TkoiLCJuYmYiOjE3NTcxNzk5NjEsImV4cCI6MTc1NzE4MTc2MSwiaXNzIjoieW91cGluODk4LmNvbSIsImRldmljZUlkIjoiMTc2YTJmNTQtOTY4Yy00M2FmLTgyMWItZTU0ZTE1ODUwOWEwIiwiYXVkIjoidXNlciJ9.lnCEoRfXZhfwzdjydwk9QytyQzlll340bM1P8Sdc7oQ",
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

// --- główna logika ---
async function scanAll() {
  console.log("Rozpoczynam nowe skanowanie...");
  const publicDir = path.join(process.cwd(), "public");
  await fs.mkdir(publicDir, { recursive: true });

  let cache = [];
  const cachePath = path.join(publicDir, "uuprices.json");
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

  const processedFirst = processPageData(first, cache);

  const changesFirst = processedFirst.reduce((acc, item) => {
    const old = cache.find((c) => c.item === item.item);
    if (!old) return acc + 1;
    if (Number(item.price) !== Number(old.price) || Number(item.onSaleCount) !== Number(old.onSaleCount)) return acc + 1;
    return acc;
  }, 0);

  if (changesFirst === 0) {
    console.log(
      "Brak nowych/zmienionych przedmiotów na stronie 1 — przerywam skanowanie."
    );
    await fs.writeFile(
      path.join(publicDir, "last_run.txt"),
      new Date().toISOString(),
      "utf-8"
    );
    return;
  }

  const newCacheMap = new Map();
  processedFirst.forEach((it) => newCacheMap.set(it.item, it));
  console.log(
    `Przetworzono stronę 1, items: ${processedFirst.length} (zmian: ${changesFirst})`
  );

  for (let p = 2; p <= pagesToFetch; p++) {
    try {
      await sleep(DELAY_MS);
      console.log(`Pobieram stronę ${p}...`);
      const pageData = await fetchPageWithRetry(p);
      const processed = processPageData(pageData, cache);

      const changes = processed.reduce((acc, item) => {
        const old = cache.find((c) => c.item === item.item);
        if (!old) return acc + 1;
        if (Number(item.price) !== Number(old.price) || Number(item.onSaleCount) !== Number(old.onSaleCount)) return acc + 1;
        return acc;
      }, 0);

      if (changes === 0) {
        console.log(`Brak zmian na stronie ${p} — przerywam dalsze skanowanie.`);
        break;
      }

      processed.forEach((it) => newCacheMap.set(it.item, it));
      console.log(
        `Przetworzono stronę ${p}, items: ${processed.length} (zmian: ${changes})`
      );
    } catch (err) {
      console.error(`Błąd przy stronie ${p}:`, err.message);
      break;
    }
  }

  const newCache = Array.from(newCacheMap.values());
  const removedCount = cache.length - newCache.length;
  cache = newCache;

  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");

  const html =
    `<!doctype html><html><head><meta charset="utf-8"><title>UU Prices</title></head><body>` +
    `<script>fetch('uuprices.json').then(r=>r.json()).then(d=>document.getElementById('json').textContent=JSON.stringify(d,null,2)).catch(e=>document.getElementById('json').textContent='Błąd: '+e)</script>` +
    `<pre id="json"></pre>` +
    `</body></html>`;
  await fs.writeFile(path.join(publicDir, "index.html"), html, "utf-8");
  await fs.writeFile(
    path.join(publicDir, "last_run.txt"),
    new Date().toISOString(),
    "utf-8"
  );

  console.log(
    `Zapisano public/ (uuprices.json, index.html, last_run.txt). Usunięto elementów: ${
      removedCount >= 0 ? removedCount : 0
    }`
  );
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
