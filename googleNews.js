import express from "express";
import axios from "axios";
import { parseStringPromise } from "xml2js";
import * as cheerio from "cheerio";
import inquirer from "inquirer";
import fs from "fs";
import pLimit from "p-limit";
import puppeteer from "puppeteer";
import cors from "cors";



const app = express();
const PORT = 5005;
const limitConcurrency = pLimit(5);

app.use(
  cors({
    origin: (origin, cb) => cb(null, true),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.options(/.*/, cors());

// Google News categories
const CATEGORIES = {
  top: "",
  world: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB",
  local: "CAAqHAgKIhZDQklTQ2pvSWJHOWpZV3hmZGpJb0FBUAE",
  business: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB",
  technology: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB",
  entertainment: "CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlnQVAB",
  sports: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pWVXlnQVAB",
  science: "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp0Y1RjU0FtVnVHZ0pWVXlnQVAB",
  health: "CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FtVnVLQUFQAQ"
};

// ---------------- Thumbnail Fetcher ----------------


const sleep = ms => new Promise(r => setTimeout(r, ms));

async function extractImage(page) {
  return page.evaluate(() => {
    const clean = s => s?.split(",")[0].split(" ")[0].trim();

    const valid = u => {
      if (!u) return false;
      u = u.toLowerCase();
      if (u.includes("spacer") || u.includes("1x1") || u.includes("logo") || u.includes("icon")) return false;
      if (u.includes("hamburger") || u.includes("menu") || u.includes("header")) return false;
      return /\.(jpg|jpeg|png|webp)/.test(u);
    };

    const list = [];

    list.push(document.querySelector('meta[property="og:image"]')?.content);
    list.push(document.querySelector('meta[name="twitter:image"]')?.content);

    document.querySelectorAll("picture source[srcset]").forEach(s => list.push(clean(s.srcset)));
    document.querySelectorAll(".elementor-widget-container img").forEach(i => list.push(i.src));
    document.querySelectorAll(".wJnIp img").forEach(i => list.push(i.src));
    document.querySelectorAll("article img, .article img").forEach(i => list.push(i.currentSrc || i.src));
    document.querySelectorAll("img").forEach(i => list.push(i.currentSrc || i.src));

    for (const c of list) {
      const u = clean(c);
      if (valid(u)) return u;
    }

    return null;
  });
}

async function fetchThumbnailFromGoogleNewsPage(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120"
  );

  try {
    // 1️⃣ Always try Google News wrapper first (works for TOI)
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    let img = await extractImage(page);
    if (img) return img;

    // 2️⃣ If redirected, go to final article (works for FIDE)
    const finalUrl = page.url();
    if (finalUrl !== url) {
      await page.goto(finalUrl, { waitUntil: "load", timeout: 20000 });
      await sleep(2500);
      img = await extractImage(page);
      if (img) return img;
    }

    return null;
  } catch (e) {
    console.warn("Thumbnail failed:", e.message);
    return null;
  } finally {
    await browser.close();
  }
}







// ---------------- Scraper ----------------

async function scrapeGoogleNews(country = "US", category = "top", limit = 20) {
  const code = CATEGORIES[category] || "";
  const url = code
    ? `https://news.google.com/rss/topics/${code}?hl=en-${country}&gl=${country}&ceid=${country}:en`
    : `https://news.google.com/rss?hl=en-${country}&gl=${country}&ceid=${country}:en`;

  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  const parsed = await parseStringPromise(data);
  const items = parsed.rss.channel[0].item.slice(0, limit);

  const articles = await Promise.all(
    items.map((item, index) =>
      limitConcurrency(async () => {
        let title = item.title[0];
        let source = "Unknown";

        if (title.includes(" - ")) {
          const parts = title.split(" - ");
          title = parts[0];
          source = parts[1];
        }

        const link = item.link?.[0];
        const thumbnail = link
          ? await fetchThumbnailFromGoogleNewsPage(link)
          : null;
        console.log('thumbnail', thumbnail)
        return {
          rank: index + 1,
          title,
          source,
          published: item.pubDate?.[0] || "N/A",
          description: item.description?.[0]?.substring(0, 200) || "N/A",
          link,
          thumbnail
        };
      })
    )
  );

  return articles;
}

// ---------------- API ----------------

app.get("/", (req, res) => {
  res.json({
    message: "Google News Scraper API",
    endpoints: {
      "/api/news": "Get news",
      "/api/categories": "List categories"
    }
  });
});

app.get("/api/categories", (req, res) => {
  res.json({ success: true, categories: Object.keys(CATEGORIES) });
});

app.get("/api/news", async (req, res) => {
  try {
    const country = (req.query.country || "US").toUpperCase();
    const category = (req.query.category || "top").toLowerCase();
    const limit = Math.min(parseInt(req.query.limit || 20), 100);

    if (!CATEGORIES.hasOwnProperty(category)) {
      return res.status(400).json({ success: false, error: "Invalid category" });
    }

    const articles = await scrapeGoogleNews(country, category, limit);

    res.json({
      success: true,
      country,
      category,
      total_articles: articles.length,
      articles
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------- CLI ----------------

async function runCLI() {
  const answers = await inquirer.prompt([
    { type: "input", name: "country", message: "Country:", default: "US" },
    {
      type: "list",
      name: "category",
      message: "Category:",
      choices: Object.keys(CATEGORIES)
    },
    { type: "number", name: "limit", message: "Articles:", default: 20 }
  ]);

  const data = await scrapeGoogleNews(
    answers.country.toUpperCase(),
    answers.category,
    answers.limit
  );

  console.log("\n--- NEWS ---\n");
  data.forEach(a => {
    console.log(`${a.rank}. ${a.title}`);
    console.log(`   ${a.source} | ${a.published}`);
    console.log(`   ${a.link}`);
    console.log(`   Thumbnail: ${a.thumbnail}\n`);
  });

  const filename = `google_news_${answers.country}_${answers.category}.json`;
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  console.log(`Saved to ${filename}`);
}

// ---------------- Runner ----------------

const mode = process.argv[2] || "api";

// if (mode === "api") {
  app.listen(PORT, () => console.log(`API running at http://localhost:${PORT}`));
// } else {
//   runCLI();
// }
